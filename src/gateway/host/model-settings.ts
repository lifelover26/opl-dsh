import { gatewayModelChoices } from '../shared/model-choices.ts'
import { gatewayGroupEnabled } from './group-settings.ts'
import { createHash } from 'node:crypto'
/** Models page operations. DSH profile settings are the only writable model catalog. */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { GATEWAY_GROUPS } from '../contracts/groups.ts'
import { DEFAULT_MODELS, toAdapterConfig } from './config.ts'
import type { ModelDraft, GatewayModelSettings } from '../contracts/models.ts'
import { isRetiredModel } from '../../shared/models.ts'
import { withGatewayModelInputDefaults } from './model-capabilities.ts'
import {
  gatewayDiscoveryBaseURL,
  gatewayInferenceBaseURL,
  isDefaultGatewayBaseURL,
} from './protocol.ts'
import {
  diagnoseGatewayModelFailure,
  gatewayCatalogStatus,
  gatewayModelDiagnostic,
  GatewayModelDiscoveryError,
  setGatewayCatalogStatus,
} from './model-diagnostics.ts'
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}

/** Preserve saved model key order for catalog hashes; settings redaction rebuilds object fields. */
function savedModelCatalogs(settings: Context['settings']): Record<string, unknown> {
  const descriptors = settings.describe()
  return Object.fromEntries(
    GATEWAY_GROUPS.map((group) => {
      const descriptor = descriptors.find(
        (item) => item.ns === (group.id === 'deepseek' ? 'opl-suite' : 'llm-pi-ai'),
      )
      const user = record(descriptor?.user)
      const profile =
        group.id === 'deepseek'
          ? record(user.gateway)
          : record(record(user.providers)[group.provider])
      return [group.id, profile.models]
    }),
  )
}

/** Read saved model declarations without treating the official schema's input defaults as user choices. */
function providerSettings(
  descriptor: Pick<SettingsDescriptor, 'value' | 'user'> | undefined,
  provider: string,
): Record<string, any> | undefined {
  const effective = record(record(descriptor?.value).providers)[provider]
  if (!effective) return undefined
  const user = record(record(record(descriptor?.user).providers)[provider])
  const { defaultInput, models: resolvedModels, ...profile } = record(effective)
  const models = Array.isArray(user.models)
    ? user.models
    : Array.isArray(resolvedModels)
      ? resolvedModels.map((model: ModelDraft) => {
          if (!Array.isArray(model.input) || model.input.length !== 0) return model
          const { input: _implicitInput, ...declared } = model
          return declared
        })
      : resolvedModels
  const policy =
    user.defaultInput ??
    (Array.isArray(defaultInput) && defaultInput.length === 1 && defaultInput[0] === 'text'
      ? undefined
      : defaultInput)
  return {
    ...profile,
    ...(models === undefined ? {} : { models }),
    ...(policy === undefined ? {} : { defaultInput: policy }),
  }
}

/** Add the OPL-owned reviewer without replacing any existing chat provider. */
export async function ensureAutoReviewProvider(ctx: Context): Promise<void> {
  const descriptor = ctx.settings
    .describe({ redactSecrets: true })
    .find((item) => item.ns === 'llm-pi-ai')
  if (!descriptor) throw Error('Auto Review requires the official pi-ai settings instance')
  const provider = record(record(descriptor.value).providers)['opl-gateway-auto-review']
  if (provider) return
  const base = record(record(descriptor.base).providers)['opl-gateway-auto-review']
  if (!base) throw Error('Auto Review provider is absent from the installed bundle')
  await ctx.settings.mutate(
    'llm-pi-ai',
    [{ op: 'set', path: ['providers', 'opl-gateway-auto-review'], value: base }],
    descriptor.revision,
  )
}

const migrations = new WeakMap<object, Promise<void>>()

/**
 * Repair bundle-owned endpoints, exact model inputs, and Opus adaptive metadata.
 * A matching saved catalog hash permits refreshing automatic text defaults.
 * Custom connections and explicit user input/compat choices win.
 */
export function migrateGatewayProtocolDefaults(ctx: Context): Promise<void> {
  const owner = ctx.root ?? ctx
  let pending = migrations.get(owner)
  if (!pending) {
    pending = migrateProtocolDefaults(ctx).finally(() => migrations.delete(owner))
    migrations.set(owner, pending)
  }
  return pending
}

async function migrateProtocolDefaults(ctx: Context): Promise<void> {
  const service = ctx.get('settings') ?? ctx.settings
  if (!service) return
  const settings = service.describe({ redactSecrets: true })
  const descriptor = settings.find((item) => item.ns === 'llm-pi-ai')
  if (!descriptor) return
  const savedCatalogs = savedModelCatalogs(service)
  const ops: import('@deepseek-ai/dsh-settings').SettingsPathOp[] = []
  const ownedHashes: { group: string; models: unknown; previous: string }[] = []
  const suite = settings.find((item) => item.ns === 'opl-suite')
  const hashes = record(record(suite?.value).gatewayCatalogHashes)
  for (const group of GATEWAY_GROUPS) {
    if (group.id === 'deepseek') continue
    const profile = providerSettings(descriptor, group.provider)
    if (
      !profile ||
      profile.api !== group.api ||
      profile.apiKeyEnv !== group.credential ||
      !isDefaultGatewayBaseURL(profile.baseURL)
    )
      continue
    const baseURL = gatewayInferenceBaseURL(profile.api)
    if (group.api === 'anthropic-messages' && profile.baseURL !== baseURL)
      ops.push({ op: 'set', path: ['providers', group.provider, 'baseURL'], value: baseURL })
    if (!Array.isArray(profile.models)) continue
    const savedModels = savedCatalogs[group.id]
    const automaticCatalog =
      Array.isArray(savedModels) && hashes[group.id] === catalogFingerprint(savedModels)
    const adaptiveModels = profile.models.map((entry: ModelDraft) => {
      if (
        group.api !== 'anthropic-messages' ||
        entry.id !== 'claude-opus-5-5' ||
        record(entry.compat).forceAdaptiveThinking !== undefined
      )
        return entry
      return { ...entry, compat: { ...record(entry.compat), forceAdaptiveThinking: true } }
    })
    const models = withGatewayModelInputDefaults(group.id, profile, adaptiveModels, {
      refreshAutomaticInputs: automaticCatalog,
    })
    if (models.every((entry, index) => entry === profile.models[index])) continue
    ops.push({ op: 'set', path: ['providers', group.provider, 'models'], value: models })
    if (automaticCatalog) ownedHashes.push({ group: group.id, models, previous: hashes[group.id] })
  }
  if (!ops.length) return
  await ctx.settings.mutate('llm-pi-ai', ops, descriptor.revision)
  if (!ownedHashes.length || !suite) return
  const updated = ctx.settings
    .describe({ redactSecrets: true })
    .find((item) => item.ns === 'opl-suite')
  if (!updated) return
  const currentHashes = record(record(updated.value).gatewayCatalogHashes)
  const stillOwned = ownedHashes.filter(({ group, previous }) => currentHashes[group] === previous)
  if (!stillOwned.length) return
  await ctx.settings.mutate(
    'opl-suite',
    stillOwned.map(({ group, models }) => ({
      op: 'set' as const,
      path: ['gatewayCatalogHashes', group],
      value: catalogFingerprint(models),
    })),
    updated.revision,
  )
}

export async function gatewayModelSettings(ctx: Context): Promise<GatewayModelSettings> {
  const settings = ctx.settings.describe({ redactSecrets: true })
  const account = await ctx.get('oplGatewayAccount')?.status()
  return {
    groups: GATEWAY_GROUPS.map((group) => {
      const descriptor = settings.find(
        (item) => item.ns === (group.id === 'deepseek' ? 'opl-suite' : 'llm-pi-ai'),
      )
      const value = record(descriptor?.value)
      const profile =
        group.id === 'deepseek'
          ? record(value.gateway)
          : (providerSettings(descriptor, group.provider) ?? {})
      const provider = group.id === 'deepseek' ? 'opl-gateway' : group.provider
      const rawModels = profile.models ?? (group.id === 'deepseek' ? DEFAULT_MODELS : [])
      const models = Array.isArray(rawModels)
        ? rawModels.filter(
            (model: any) => !isRetiredModel({ provider, model: String(model?.id ?? '') }),
          )
        : []
      const status = account?.groups?.find((item) => item.id === group.id)
      return {
        enabled: gatewayGroupEnabled(ctx, group.id),
        ...(status?.rateMultiplier !== undefined ? { rateMultiplier: status.rateMultiplier } : {}),
        id: group.id,
        name: group.name,
        api: String(profile.api ?? group.api),
        models,
        catalog: gatewayCatalogStatus(ctx, group.id),
        state: account?.groups?.find((item) => item.id === group.id)?.state ?? 'unconfigured',
        ready:
          gatewayGroupEnabled(ctx, group.id) &&
          (account?.groups?.some((item) => item.id === group.id && item.state === 'ready') ??
            false),
        revision: descriptor?.revision ?? 0,
      }
    }),
  }
}
export async function editGatewayModels(
  ctx: Context,
  input: unknown,
): Promise<GatewayModelSettings> {
  const args = record(input),
    group = GATEWAY_GROUPS.find((item) => item.id === args.group)
  if (!group || !Array.isArray(args.models) || !Number.isSafeInteger(args.revision))
    throw Error('模型配置无效，请重新打开模型页')
  const ids = new Set<string>()
  const models = args.models.map((value: unknown) => {
    const item = record(value)
    if (
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      item.id.includes('::') ||
      ids.has(item.id)
    )
      throw Error('模型 ID 为空、重复或包含保留分隔符')
    ids.add(item.id)
    if (
      item.contextWindow !== undefined &&
      (!Number.isSafeInteger(item.contextWindow) || item.contextWindow < 1)
    )
      throw Error('上下文长度必须为正整数')
    return item
  })
  const activeModels = models.filter(
    (model) =>
      !isRetiredModel({
        provider: group.id === 'deepseek' ? 'opl-gateway' : group.provider,
        model: String(model.id),
      }),
  )
  if (group.id === 'deepseek') {
    await ctx.settings.mutate(
      'opl-suite',
      [{ op: 'set', path: ['gateway', 'models'], value: activeModels }],
      args.revision,
    )
  } else {
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(args.api))
      throw Error('不支持的模型协议')
    const descriptor = ctx.settings.describe().find((item) => item.ns === 'llm-pi-ai')
    const profile = providerSettings(descriptor, group.provider)
    const updateBaseURL =
      profile &&
      (profile.baseURL === undefined ||
        (profile.apiKeyEnv === group.credential && isDefaultGatewayBaseURL(profile.baseURL)))
    const completeModels = withGatewayModelInputDefaults(
      group.id,
      profile
        ? {
            ...profile,
            api: args.api,
            ...(updateBaseURL ? { baseURL: gatewayInferenceBaseURL(args.api) } : {}),
          }
        : {
            api: args.api,
            baseURL: gatewayInferenceBaseURL(args.api),
            apiKeyEnv: group.credential,
          },
      activeModels as ModelDraft[],
    )
    const ops: import('@deepseek-ai/dsh-settings').SettingsPathOp[] = profile
      ? [
          { op: 'set', path: ['providers', group.provider, 'models'], value: completeModels },
          { op: 'set', path: ['providers', group.provider, 'api'], value: args.api },
        ]
      : [
          {
            op: 'set',
            path: ['providers', group.provider],
            value: {
              displayName: `OPL Gateway · ${group.name}`,
              api: args.api,
              baseURL: gatewayInferenceBaseURL(args.api),
              apiKeyEnv: group.credential,
              models: completeModels,
            },
          },
        ]
    if (updateBaseURL)
      ops.push({
        op: 'set',
        path: ['providers', group.provider, 'baseURL'],
        value: gatewayInferenceBaseURL(args.api),
      })
    await ctx.settings.mutate('llm-pi-ai', ops, args.revision)
  }
  return gatewayModelSettings(ctx)
}
/** List candidates using the configured endpoint and credential reference, without saving models. */
export async function discoverGatewayModels(ctx: Context, input: unknown): Promise<ModelDraft[]> {
  const group = GATEWAY_GROUPS.find((item) => item.id === record(input).group)
  if (!group) throw Error('未知分组')
  let signal: AbortSignal | undefined
  const fail: (code: import('../contracts/models.ts').GatewayModelDiagnostic['code']) => never = (
    code,
  ) => {
    throw new GatewayModelDiscoveryError(group.id, group.name, gatewayModelDiagnostic(code))
  }
  try {
    if (!gatewayGroupEnabled(ctx, group.id)) fail('disabled')
    const settings = ctx.get('settings') ?? ctx.settings
    const credentials = ctx.get('credentials') ?? ctx.credentials
    const llm = ctx.get('llm') ?? ctx.llm
    if (!settings || !credentials || !llm) fail('service_unavailable')
    const descriptors = settings.describe({ redactSecrets: true })
    const descriptor = descriptors.find(
      (item) => item.ns === (group.id === 'deepseek' ? 'opl-suite' : 'llm-pi-ai'),
    )
    if (!descriptor) fail('service_unavailable')
    const configuredProfile =
      group.id === 'deepseek'
        ? record(descriptor.value).gateway
        : providerSettings(descriptor, group.provider)
    const profile = record(configuredProfile)
    const deepseek = group.id === 'deepseek' ? toAdapterConfig(profile) : undefined
    const api =
      group.id === 'deepseek'
        ? group.api
        : (profile.api ?? (!configuredProfile ? group.api : undefined))
    const ref =
      (deepseek ? deepseek.apiKeyEnv : profile.apiKeyEnv) ??
      (group.id === 'deepseek' || !configuredProfile ? group.credential : undefined)
    if (typeof api !== 'string' || typeof ref !== 'string' || !ref.trim()) fail('configuration')
    let baseURL: string
    try {
      baseURL = gatewayDiscoveryBaseURL(
        (deepseek ? deepseek.baseURL : profile.baseURL) ?? gatewayInferenceBaseURL(api),
        api,
      )
    } catch {
      fail('configuration')
    }
    let key: string | undefined
    try {
      key = (await credentials.resolve(ref as import('@deepseek-ai/dsh-credentials').CredentialRef))
        ?.value
    } catch {
      fail('service_unavailable')
    }
    if (!key) fail('missing_credentials')
    signal = AbortSignal.timeout(15000)
    const models = await llm.discoverModels(
      'llm-pi-ai',
      {
        ...(group.id === 'deepseek' ? {} : { provider: group.provider }),
        baseURL,
        api: 'openai-completions',
        apiKey: key,
      },
      signal,
    )
    const configured: ModelDraft[] =
      profile.models ?? (group.id === 'deepseek' ? DEFAULT_MODELS : [])
    const offered = new Set(models.map((model) => model.id))
    const choices = gatewayModelChoices(
      models.map((model) => ({ ...model })),
      configured,
    ).filter(
      (model) =>
        offered.has(model.id) && !isRetiredModel({ provider: group.provider, model: model.id }),
    )
    const candidates = withGatewayModelInputDefaults(
      group.id,
      { ...profile, api, apiKeyEnv: ref, baseURL: profile.baseURL ?? gatewayInferenceBaseURL(api) },
      choices,
    )
    setGatewayCatalogStatus(ctx, group.id, {
      state: candidates.length ? 'ready' : 'empty',
      count: candidates.length,
    })
    return candidates
  } catch (error) {
    const diagnostic = diagnoseGatewayModelFailure(error, signal)
    setGatewayCatalogStatus(ctx, group.id, { state: 'error', diagnostic })
    throw new GatewayModelDiscoveryError(group.id, group.name, diagnostic)
  }
}

/** Refresh only catalogs whose user layer still equals the last automatic import. */
export async function syncGatewayModels(ctx: Context): Promise<void> {
  await migrateGatewayProtocolDefaults(ctx)
  for (const group of GATEWAY_GROUPS) {
    if (!gatewayGroupEnabled(ctx, group.id)) continue
    try {
      if (!ctx.get('settings'))
        throw new GatewayModelDiscoveryError(
          group.id,
          group.name,
          gatewayModelDiagnostic('service_unavailable'),
        )
      const settings = ctx.settings.describe({ redactSecrets: true })
      const suite = settings.find((item) => item.ns === 'opl-suite')
      const ns = group.id === 'deepseek' ? suite : settings.find((item) => item.ns === 'llm-pi-ai')
      if (!suite || !ns)
        throw new GatewayModelDiscoveryError(
          group.id,
          group.name,
          gatewayModelDiagnostic('service_unavailable'),
        )
      const savedModels = savedModelCatalogs(ctx.settings)[group.id]
      const hashes = record(record(suite.value).gatewayCatalogHashes)
      // A pre-existing user model list is always preserved unless we can prove ownership.
      if (savedModels !== undefined && hashes[group.id] !== catalogFingerprint(savedModels))
        continue
      let candidates = await discoverGatewayModels(ctx, { group: group.id })
      // Do not make the default DeepSeek Flash route depend on the optional
      // OpenAI-protocol group. A user can still explicitly add this channel
      // from the model page, which is the durable opt-in boundary.
      if (group.id === 'codex' && savedModels === undefined)
        candidates = candidates.filter((model) => model.id !== 'deepseek-flash')
      if (!candidates.length) continue
      const snapshot = await gatewayModelSettings(ctx),
        current = snapshot.groups.find((item) => item.id === group.id)!
      const models = candidates.map((candidate) => {
        const known = current.models.find((model) => model.id === candidate.id)
        return { ...known, ...candidate, ...(known?.name ? { name: known.name } : {}) }
      })
      // The captured revision prevents a concurrent manual edit from being overwritten.
      await editGatewayModels(ctx, {
        group: group.id,
        models,
        api: current.api,
        revision: ns.revision,
      })
      const updated = ctx.settings
        .describe({ redactSecrets: true })
        .find((item) => item.ns === 'opl-suite')!
      await ctx.settings.mutate(
        'opl-suite',
        [
          {
            op: 'set',
            path: ['gatewayCatalogHashes', group.id],
            value: catalogFingerprint(models),
          },
        ],
        updated.revision,
      )
    } catch (error) {
      const diagnostic = diagnoseGatewayModelFailure(error)
      setGatewayCatalogStatus(ctx, group.id, { state: 'error', diagnostic })
      if (diagnostic.code !== 'missing_credentials')
        ctx.logger.warn(`OPL Gateway ${group.name} [${diagnostic.code}]: ${diagnostic.message}`)
    }
  }
}
function catalogFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
