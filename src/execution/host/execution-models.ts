import { invokeHostRemote } from '../../compat/host/remote-invocation.ts'
/** Owns live model/combination projection; persisted catalog stores references only. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  internalGatewayProvider,
  gatewayModelSettings,
} from '../../gateway/host/execution-access.ts'
import { DSH_COMBINATION } from '../contracts/sessions.ts'
import {
  displayModelName,
  displayModelSource,
  isRetiredModel,
  modelRefKey,
  type CombinationDefinition,
  type ModelRef,
} from '../contracts/catalog.ts'
import { ExecutionCatalogStore, type ExecutionCatalog } from './catalog.ts'
import { defaultHarness, automaticHarness } from './adapters/index.ts'
import { officialHarnessFor } from '../contracts/official-harnesses.ts'
import {
  minimaxCodeCombinations,
  minimaxCodeModels,
  MINIMAX_CODE_HARNESS,
  MINIMAX_CODE_PROVIDER,
} from './adapters/minimax.ts'
import {
  isHiddenOfmSelection,
  officialOpenCodeModel,
  OFM_INACTIVE_DEFAULT_HARNESSES,
} from './ofm-source/selection-policy.ts'
import { OFM_PROVIDER, OFM_PROVIDERS, isExcludedOfmModel } from './ofm-source/provider.ts'
import { ofmModelReadiness, type OfmModelReadiness } from './ofm-source/readiness.ts'
import { BAMBOO_STARTLUX_MODEL } from './adapters/bamboo.ts'
import { JEV_DECISION_MODEL, JEV_TYPESAFE_MODEL } from './adapters/jev.ts'
import { adapterFor } from './adapters/index.ts'
export class ExecutionModelResolver {
  constructor(
    private readonly ctx: Context,
    private readonly store: ExecutionCatalogStore,
    /**
     * Probes a model that an external official CLI owns. These models bypass the OPL
     * Gateway registry entirely, so their availability must come from the CLI itself
     * (installed, signed in) rather than from a Gateway credential.
     */
    private readonly probeExternal?: (
      ref: ModelRef,
    ) => Promise<{ available: boolean; reason?: string }>,
    private readonly readOfm?: () => Promise<unknown>,
  ) {}
  async resolve(): Promise<ExecutionCatalog> {
    let catalog = await this.store.get()
    // Remove combinations from old releases before projecting the live model
    // registry. The write is idempotent and keeps the on-disk catalog clean so
    // retired entries cannot return after a restart.
    const retired = catalog.combinations.filter((item) => isRetiredModel(item.modelRef))
    const legacyDefault = catalog.combinations.find(
      (item) => item.id === DSH_COMBINATION && item.name === 'DeepSeek + DSH',
    )
    const userEdited = (item: CombinationDefinition) =>
      item.autoEnabled === false && item.autoEnabledDisabled === true
    const legacyNemotronKiloRoute = (item: CombinationDefinition) =>
      item.modelRef.provider === OFM_PROVIDER &&
      item.modelRef.model === 'nvidia/nemotron-3-super-120b-a12b:free' &&
      item.harnessRef === 'opencode'
    const staleAutomatic = (item: CombinationDefinition) =>
      item.id.startsWith('auto:') &&
      !userEdited(item) &&
      (officialHarnessFor(item.modelRef) !== item.harnessRef ||
        automaticHarness(item.modelRef) !== item.harnessRef)
    if (retired.length || legacyDefault || catalog.combinations.some(staleAutomatic)) {
      catalog = await this.store.cleanLegacyCombinations(staleAutomatic)
    }
    if (catalog.combinations.some(legacyNemotronKiloRoute)) {
      catalog = await this.store.set({
        ...catalog,
        combinations: catalog.combinations.map((item) =>
          legacyNemotronKiloRoute(item)
            ? {
                ...item,
                name: 'Kilo Nemotron 3 Super + Kilo Code',
                harnessRef: 'kilo',
              }
            : item,
        ),
      })
    }
    catalog.combinations = catalog.combinations.filter((item) => !staleAutomatic(item))
    const providers = this.ctx.llm?.listProviders() ?? []
    const configurable = this.ctx.llm?.listConfigurableProviders() ?? []
    const settings = this.ctx.get('settings')
    const externalAvailability = new Map<string, Promise<{ available: boolean; reason?: string }>>()
    const probeExternal = (ref: ModelRef) => {
      const model = modelRefKey(ref)
      const existing = externalAvailability.get(model)
      if (existing) return existing
      const pending =
        this.probeExternal?.(ref) ??
        Promise.resolve({ available: false, reason: '外部 Harness 未就绪' })
      externalAvailability.set(model, pending)
      return pending
    }
    const ofmSummary = this.readOfm?.().catch(() => undefined)
    const ofmAvailability = new Map<string, Promise<OfmModelReadiness>>()
    const probeOfm = (ref: ModelRef) => {
      const model = modelRefKey(ref)
      const existing = ofmAvailability.get(model)
      if (existing) return existing
      const pending: Promise<OfmModelReadiness> =
        ofmSummary === undefined
          ? Promise.resolve({ available: true })
          : ofmSummary.then((summary) =>
              summary === undefined
                ? {
                    available: false,
                    reason: 'OFM 状态读取失败，对应模型尚未确认启用',
                    unavailableKind: 'unconfirmed' as const,
                  }
                : ofmModelReadiness(summary, ref, defaultHarness(ref) !== 'dsh'),
            )
      ofmAvailability.set(model, pending)
      return pending
    }
    const providerModels = await Promise.all(
      providers.map(async (provider) => {
        if (internalGatewayProvider(provider.id)) return []
        const directory = configurable.find((item) => item.provider === provider.id)
        let configured = true
        if (directory && provider.id !== 'opl-gateway') {
          let profile = settings?.describe().find((item) => item.ns === directory.settingsNs)
            ?.value as any
          for (const key of directory.settingsPath) profile = profile?.[key]
          if (profile?.apiKeyEnv)
            configured = !!(
              await this.ctx.get('credentials')?.resolve(credentialRef(profile.apiKeyEnv))
            )?.value
        }
        // The official DeepSeek adapter always exposes its built-in catalog, but
        // that catalog is not a usable connection until a key is configured.
        // A missing descriptor therefore means "not configured", rather than a
        // reason to populate the combination picker with empty models.
        if ((provider.id === 'deepseek-official' || provider.id === 'deepseek') && !directory)
          configured = false
        if (provider.id === 'deepseek-account') {
          try {
            configured =
              (
                (await invokeHostRemote(this.ctx, {
                  namespace: 'account',
                  method: 'getState',
                  args: {},
                })) as { status: string }
              ).status === 'credential-stored'
          } catch {
            configured = false
          }
          // Account model discovery requires a signed-in connection. Saved model
          // references remain visible as unavailable below without making that request.
          if (!configured) return []
        }
        try {
          const models = await this.ctx.llm.listModels(provider.id)
          return await Promise.all(
            models.flatMap((model) => {
              if (provider.id === 'opl-gateway' && model.id === 'codex::codex-auto-review')
                return []
              if (
                provider.id === BAMBOO_STARTLUX_MODEL.provider ||
                provider.id === JEV_DECISION_MODEL.provider ||
                provider.id === JEV_TYPESAFE_MODEL.provider
              )
                return []
              if (isHiddenOfmSelection({ provider: provider.id, model: model.id })) return []
              const ref = { provider: provider.id, model: model.id }
              if (isRetiredModel(ref)) return []
              const external =
                provider.id === MINIMAX_CODE_PROVIDER ? probeExternal(ref) : undefined
              const ofm = OFM_PROVIDERS.includes(provider.id) ? probeOfm(ref) : undefined
              const source =
                provider.id === 'deepseek-account'
                  ? 'DeepSeek 官方'
                  : provider.id === 'opl-gateway'
                    ? 'OPL Gateway'
                    : provider.name
              return [
                Promise.resolve<OfmModelReadiness | undefined>(external ?? ofm).then(
                  (availability) => ({
                    ref,
                    name: displayModelName(ref, model.name),
                    source: displayModelSource(
                      ref,
                      officialOpenCodeModel(ref) ? 'OpenCode 官方免费通道' : source,
                    ),
                    available: availability?.available ?? configured,
                    ...(availability
                      ? availability.available
                        ? {}
                        : {
                            reason: availability.reason ?? '外部 Harness 未就绪',
                            ...(availability.unavailableKind
                              ? { unavailableKind: availability.unavailableKind }
                              : {}),
                          }
                      : !configured
                        ? { reason: '凭据未配置' }
                        : {}),
                  }),
                ),
              ]
            }),
          )
        } catch {
          /* Keep saved references visible as unavailable below. */
          return []
        }
      }),
    )
    const rawSummary = ofmSummary ? await ofmSummary : undefined
    const rawCatalog =
      rawSummary !== null && typeof rawSummary === 'object' && rawSummary !== undefined
        ? (rawSummary as { catalog?: unknown }).catalog
        : undefined
    // A successful OFM snapshot with a live membership route is authoritative for
    // generated external routes. Remove generated rows whose model disappeared
    // from that live route, while retaining user-created rows so a transient
    // upstream change cannot destroy an explicit choice. A failed, cached-only,
    // or incomplete summary never prunes.
    const rawSettings =
      rawSummary !== null && typeof rawSummary === 'object' && rawSummary !== undefined
        ? (rawSummary as { settings?: unknown }).settings
        : undefined
    const rawMembership =
      rawSummary !== null && typeof rawSummary === 'object' && rawSummary !== undefined
        ? (rawSummary as { membership?: unknown }).membership
        : undefined
    const membershipModels =
      rawMembership !== null && typeof rawMembership === 'object' && rawMembership !== undefined
        ? Object.values(rawMembership as Record<string, unknown>).flatMap((value) =>
            Array.isArray(value)
              ? value.filter((model): model is string => typeof model === 'string')
              : [],
          )
        : []
    const hasLiveMembership = membershipModels.length > 0
    if (
      Array.isArray(rawCatalog) &&
      rawSettings !== null &&
      typeof rawSettings === 'object' &&
      (rawSettings as { enabled?: unknown }).enabled === true &&
      hasLiveMembership
    ) {
      const liveOfmModels = new Set(
        rawCatalog.flatMap((entry) => {
          if (entry === null || typeof entry !== 'object' || !('id' in entry)) return []
          const id = (entry as { id?: unknown }).id
          return typeof id === 'string' && id ? [id] : []
        }),
      )
      const staleOfmAutomatic = (item: CombinationDefinition) =>
        item.id.startsWith('auto:') &&
        !userEdited(item) &&
        OFM_PROVIDERS.includes(item.modelRef.provider) &&
        (!liveOfmModels.has(item.modelRef.model) || !membershipModels.includes(item.modelRef.model))
      if (catalog.combinations.some(staleOfmAutomatic)) {
        catalog = await this.store.cleanLegacyCombinations(staleOfmAutomatic)
      }
    }
    catalog.combinations = catalog.combinations.filter(
      (item) => !isHiddenOfmSelection(item.modelRef),
    )
    for (const item of catalog.combinations) {
      if (!item.id.startsWith('auto:')) continue
      item.generated = !userEdited(item)
      if (!item.enabled) item.autoEnabledDisabled = true
    }
    // Cleanup reloads persisted references; attach the live projection afterwards.
    for (const models of providerModels) catalog.models.push(...models)
    if (Array.isArray(rawCatalog))
      for (const entry of rawCatalog) {
        if (entry === null || typeof entry !== 'object' || !('id' in entry)) continue
        const id = (entry as { id?: unknown }).id
        if (typeof id !== 'string' || !id) continue
        const ref = { provider: OFM_PROVIDER, model: id }
        if (isHiddenOfmSelection(ref) || isRetiredModel(ref)) continue
        const readiness = ofmModelReadiness(rawSummary, ref, automaticHarness(ref) !== 'dsh')
        const entryName = (entry as { name?: unknown }).name
        const name = displayModelName(ref, typeof entryName === 'string' ? entryName : undefined)
        const existing = catalog.models.find((model) => modelRefKey(model.ref) === modelRefKey(ref))
        if (existing) {
          existing.name = name
          existing.available = readiness.available
          if (readiness.unavailableKind) existing.unavailableKind = readiness.unavailableKind
          else delete existing.unavailableKind
          if (readiness.available) delete existing.reason
          else existing.reason = readiness.reason ?? 'OFM 模型尚未就绪'
        } else {
          catalog.models.push({
            ref,
            name,
            source: displayModelSource(
              ref,
              officialOpenCodeModel(ref) ? 'OpenCode 官方免费通道' : 'Our Free Model',
            ),
            available: readiness.available,
            ...(readiness.available
              ? {}
              : {
                  reason: readiness.reason ?? 'OFM 模型尚未就绪',
                  ...(readiness.unavailableKind
                    ? { unavailableKind: readiness.unavailableKind }
                    : {}),
                }),
          })
        }
      }
    if (this.ctx.get('settings')) {
      const configured = await gatewayModelSettings(this.ctx)
      for (const group of configured.groups)
        for (const model of group.models) {
          const ref = {
            provider: 'opl-gateway',
            model: group.id === 'deepseek' ? model.id : group.id + '::' + model.id,
          }
          if (isRetiredModel(ref)) continue
          if (!catalog.models.some((item) => modelRefKey(item.ref) === modelRefKey(ref)))
            catalog.models.push({
              ref,
              name: displayModelName(ref, model.name),
              source: 'OPL Gateway',
              available: false,
              reason: '分组凭据未就绪',
            })
        }
    }
    // The official MiniMax Code CLI owns its own account and model list, so these two
    // models are never projected from the OPL Gateway provider registry. They are only
    // marked available once the CLI itself is installed and signed in, so a missing
    // Gateway key never hides them and an absent CLI never advertises them.
    for (const model of minimaxCodeModels())
      if (!catalog.models.some((item) => modelRefKey(item.ref) === modelRefKey(model))) {
        const probe = this.probeExternal
          ? await probeExternal(model)
          : { available: false, reason: '尚未安装官方 MiniMax Code CLI' }
        catalog.models.push({
          ref: model,
          name: displayModelName(model),
          source: displayModelSource(model),
          available: probe.available,
          ...(probe.available ? {} : { reason: probe.reason ?? '官方 MiniMax Code 未就绪' }),
        })
      }
    for (const fixed of minimaxCodeCombinations()) {
      const modelRef = { provider: MINIMAX_CODE_PROVIDER, model: fixed.model }
      const available = await probeExternal(modelRef)
      const existing = catalog.combinations.find((item) => item.id === fixed.combination)
      if (!existing)
        catalog.combinations.push({
          id: fixed.combination,
          name: fixed.name,
          modelRef,
          harnessRef: MINIMAX_CODE_HARNESS,
          permissionPolicy: 'full-access',
          isDefault: true,
          enabled: available.available,
          autoEnabled: true,
        })
      else {
        // Existing rows from before this field was introduced keep their
        // current state on first projection. A disabled row is treated as an
        // explicit user choice; an enabled row remains managed by readiness.
        if (existing.autoEnabled === undefined) existing.autoEnabled = existing.enabled
        Object.assign(existing, {
          modelRef,
          harnessRef: MINIMAX_CODE_HARNESS,
          permissionPolicy: 'full-access',
          isDefault: true,
          ...(existing.autoEnabled && !existing.autoEnabledDisabled
            ? { enabled: available.available }
            : {}),
        })
      }
    }
    for (const combination of catalog.combinations)
      if (
        !isRetiredModel(combination.modelRef) &&
        !catalog.models.some(
          (model) => modelRefKey(model.ref) === modelRefKey(combination.modelRef),
        )
      ) {
        const ofm = OFM_PROVIDERS.includes(combination.modelRef.provider)
          ? await probeOfm(combination.modelRef)
          : undefined
        catalog.models.push({
          ref: combination.modelRef,
          name: displayModelName(combination.modelRef),
          source: displayModelSource(combination.modelRef),
          available: false,
          reason: ofm
            ? ofm.available
              ? 'OFM 目录包含此模型，但模型服务尚未加载'
              : (ofm.reason ?? 'OFM 模型状态尚未确认')
            : '模型未配置或分组未授权',
          ...(ofm?.available
            ? { unavailableKind: 'unconfirmed' as const }
            : ofm?.unavailableKind
              ? { unavailableKind: ofm.unavailableKind }
              : {}),
        })
      }
    for (const model of catalog.models) {
      const hasDefault = catalog.combinations.some(
        (item) =>
          !isRetiredModel(item.modelRef) &&
          modelRefKey(item.modelRef) === modelRefKey(model.ref) &&
          (item.id === 'auto:' + modelRefKey(model.ref) ||
            item.autoEnabledDisabled === true ||
            (item.enabled && item.isDefault)),
      )
      const official = officialHarnessFor(model.ref)
      const harnessRef = automaticHarness(model.ref) === official ? official : undefined
      if (!isRetiredModel(model.ref) && model.available && !hasDefault && harnessRef) {
        const harnessName = catalog.harnesses.find((h) => h.id === harnessRef)?.name ?? 'DSH'
        catalog.combinations.push({
          id: 'auto:' + modelRefKey(model.ref),
          name:
            displayModelName(model.ref, model.name) +
            ' + ' +
            harnessName +
            (officialOpenCodeModel(model.ref) ? '（官方免费通道）' : ''),
          modelRef: model.ref,
          harnessRef,
          permissionPolicy: 'read-only',
          isDefault: true,
          enabled: true,
          generated: true,
        })
      }
    }
    // A persisted automatic row is a projection, not a user decision. Keep its
    // identity and permission settings, but make its enabled state follow the
    // model that actually owns it. This also repairs rows written by an older
    // release that enabled every advertised OFM lane before the source was ready.
    for (const combination of catalog.combinations) {
      if (!combination.generated || isRetiredModel(combination.modelRef)) continue
      const model = catalog.models.find(
        (item) => modelRefKey(item.ref) === modelRefKey(combination.modelRef),
      )
      // An absent model row means the fixture or source never projected a
      // readiness verdict. Keep the saved state in that case; a projected row
      // is an explicit verdict and owns the automatic row's enabled state.
      if (model && !combination.autoEnabledDisabled) combination.enabled = model.available
    }
    catalog.recommendations = catalog.models.flatMap((model) => {
      const harnessRef = automaticHarness(model.ref)
      if (
        !model.available ||
        !harnessRef ||
        harnessRef === officialHarnessFor(model.ref) ||
        !catalog.harnesses.some((h) => h.id === harnessRef)
      )
        return []
      const harnessName = catalog.harnesses.find((h) => h.id === harnessRef)!.name
      return [{ modelRef: model.ref, harnessRef, name: model.name + ' + ' + harnessName }]
    })
    const ofmDiscovery = new Map<string, (typeof catalog.models)[number]>()
    for (const model of catalog.models)
      if (OFM_PROVIDERS.includes(model.ref.provider))
        ofmDiscovery.set(modelRefKey(model.ref), model)
    catalog.ofmDiscovery = [...ofmDiscovery.values()].map((model) => {
      const declaredOfficial = officialHarnessFor(model.ref)
      const official =
        declaredOfficial &&
        !OFM_INACTIVE_DEFAULT_HARNESSES.includes(declaredOfficial) &&
        catalog.harnesses.some(
          (harness) =>
            harness.id === declaredOfficial && adapterFor(harness.id, model.ref) !== undefined,
        )
          ? declaredOfficial
          : undefined
      const automatic = automaticHarness(model.ref)
      const harnesses = catalog.harnesses
        .filter((harness) => adapterFor(harness.id, model.ref) !== undefined)
        .map((harness) => harness.id)
      const status = isExcludedOfmModel(model.ref.model)
        ? {
            kind: 'excluded' as const,
            reason: '决策或内容安全用途，不加入对话组合',
            label: '非对话模型',
          }
        : official
          ? {
              kind: 'official' as const,
              harness: official,
              label: `官方 ${catalog.harnesses.find((h) => h.id === official)?.name ?? official}`,
            }
          : automatic && automatic !== 'dsh'
            ? {
                kind: 'recommended' as const,
                harness: automatic,
                label: `推荐 ${catalog.harnesses.find((h) => h.id === automatic)?.name ?? automatic}`,
              }
            : harnesses.length
              ? { kind: 'manual' as const, harnesses, label: '仅可手动尝试' }
              : { kind: 'unknown' as const, label: '尚未适配' }
      return { modelRef: model.ref, name: model.name, available: model.available, status }
    })
    return catalog
  }
}
