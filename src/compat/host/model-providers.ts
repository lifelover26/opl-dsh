/** Extend the official provider configuration, retaining its editor and adapter. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import * as official from '@deepseek-ai/dsh-llm-pi-ai'
import {
  BAMBOO_STARTLUX_CREDENTIAL_REF,
  JEV_TYPESAFE_CREDENTIAL_REF,
} from '../../credentials/contracts/windows-keyring.ts'
import { installProviderKeyringOverlay } from '../../credentials/host/keyring-overlay.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  BambooStartLuxAdapter,
  BAMBOO_STARTLUX_MODEL,
} from '../../execution/host/adapters/bamboo.ts'
import type { Volatile } from '@deepseek-ai/cordis'
import {
  JevDecisionAdapter,
  JEV_DECISION_MODEL,
  JEV_TYPESAFE_MODEL,
  JEV_TYPESAFE_ENDPOINT,
} from '../../execution/host/adapters/jev.ts'
import type {} from '@deepseek-ai/dsh-settings'

export const inject = ['loader', 'llm', 'settings', 'credentials']
const bambooProfile = z.object({
  apiKeyEnv: z.const(BAMBOO_STARTLUX_CREDENTIAL_REF).default(BAMBOO_STARTLUX_CREDENTIAL_REF),
  baseURL: z
    .const('https://api.bamboonode.dev/v1/decisions')
    .default('https://api.bamboonode.dev/v1/decisions'),
  api: z.const('bamboo-decisions').default('bamboo-decisions'),
  models: z
    .array(
      z.object({
        id: z.const('startlux-decision-27b-autothink'),
        name: z.string().default('StartLux Decision 27B AutoThink'),
      }),
    )
    .min(1)
    .max(1)
    .default([{ id: 'startlux-decision-27b-autothink', name: 'StartLux Decision 27B AutoThink' }]),
})
const jevProfile = z.object({
  apiKeyEnv: z.const(JEV_TYPESAFE_CREDENTIAL_REF).default(JEV_TYPESAFE_CREDENTIAL_REF),
  baseURL: z.const(JEV_TYPESAFE_ENDPOINT).default(JEV_TYPESAFE_ENDPOINT),
  api: z.const('typesafe-systemone').default('typesafe-systemone'),
  models: z
    .array(
      z.object({ id: z.const(JEV_TYPESAFE_MODEL.model), name: z.string().default('Jev 1.13') }),
    )
    .min(1)
    .max(1)
    .default([{ id: JEV_TYPESAFE_MODEL.model, name: 'Jev 1.13' }]),
})
const extraFields = {
  jevProviders: z.dict(jevProfile, z.const(JEV_TYPESAFE_MODEL.provider)).default({}).volatile(),
  bambooProviders: z.dict(bambooProfile, z.const('bamboo-startlux')).default({}).volatile(),
  providerKeyringMigration: z.number().default(0).volatile(),
}
type ExtraConfig = {
  bambooProviders: Volatile<
    Record<string, { baseURL: string; models: { id: string; name: string }[] }>
  >
  providerKeyringMigration: Volatile<number>
}

/** The native editor only recognizes official adapter namespaces. Extend the
 * existing public Schema and fiber; never duplicate/replace its loader entry.
 * Keep this compatibility seam removable when native providers support arbitrary families. */
export async function apply(ctx: Context): Promise<void> {
  ctx.llm.registerAdapter([JEV_DECISION_MODEL.provider], new JevDecisionAdapter())
  const keyringOverlay = installProviderKeyringOverlay(ctx)
  ctx.effect(() => keyringOverlay.dispose)
  const ns = 'llm-pi-ai'
  const entry = [...ctx.loader.entries()].find(
    (item) => item.options.id === ns && item.options.name === '@deepseek-ai/dsh-llm-pi-ai',
  )
  if (!entry?.fiber?.runtime?.Config) throw new Error('官方模型供应商配置实例不可用')
  const schema = entry.fiber.runtime.Config as typeof official.Config
  ctx.effect(() => {
    const previous = new Map(Object.keys(extraFields).map((key) => [key, schema.dict?.[key]]))
    for (const [key, field] of Object.entries(extraFields)) schema.set(key, field)
    return () => {
      for (const [key, field] of Object.entries(extraFields)) {
        if (schema.dict?.[key] !== field) continue
        const old = previous.get(key)
        if (old) schema.set(key, old)
        else delete schema.dict![key]
      }
    }
  })
  // Reparse the same raw config once, so the new fields have official volatile
  // references before settings reads them. No config or package bytes are rewritten.
  await entry.fiber.restart()
  // The official editor probes by namespace and provider, without an endpoint.
  // The native editor recognizes the pi-ai namespace; Jev uses its own wire API.
  ctx.effect(() => {
    const llm = ctx.llm
    const previous = Object.getOwnPropertyDescriptor(llm, 'discoverModels')
    const discover = llm.discoverModels
    const adapted: typeof discover = async function (
      this: Context['llm'],
      settingsNs,
      request,
      signal,
    ) {
      if (settingsNs === ns && request.provider === JEV_TYPESAFE_MODEL.provider) {
        signal?.throwIfAborted()
        return [{ id: JEV_TYPESAFE_MODEL.model, name: 'Jev 1.13' }]
      }
      return discover.call(this, settingsNs, request, signal)
    }
    Object.defineProperty(llm, 'discoverModels', {
      configurable: true,
      writable: true,
      value: adapted,
    })
    return () => {
      if (Object.getOwnPropertyDescriptor(llm, 'discoverModels')?.value !== adapted) return
      if (previous) Object.defineProperty(llm, 'discoverModels', previous)
      else Reflect.deleteProperty(llm, 'discoverModels')
    }
  })
  const configuration = () => entry.fiber!.effectiveConfig as ExtraConfig
  const keyringMigrationNeeded = configuration().providerKeyringMigration.get() < 1
  if (keyringMigrationNeeded) {
    await keyringOverlay.migratePlaintext()
    const view = ctx.settings.describe().find((item) => item.ns === ns)
    if (!view) throw new Error('官方模型供应商设置不可用，Bamboo 凭据迁移状态未保存')
    await ctx.settings.mutate(
      ns,
      [{ op: 'set', path: ['providerKeyringMigration'], value: 1 }],
      view.revision,
    )
  }
  ctx.llm.registerConfigurableProviders([
    {
      provider: JEV_TYPESAFE_MODEL.provider,
      displayName: 'TypeSafe · Jev',
      settingsNs: ns,
      settingsPath: ['jevProviders', JEV_TYPESAFE_MODEL.provider],
    },
    {
      provider: 'bamboo-startlux',
      displayName: 'BambooNode · StartLux',
      settingsNs: ns,
      settingsPath: ['bambooProviders', 'bamboo-startlux'],
    },
  ])
  const bambooAdapter = new BambooStartLuxAdapter(
    async () =>
      (await ctx.credentials.resolve(credentialRef(BAMBOO_STARTLUX_CREDENTIAL_REF)))?.value,
  )
  const jevAdapter = new JevDecisionAdapter(
    JEV_TYPESAFE_ENDPOINT,
    async () => (await ctx.credentials.resolve(credentialRef(JEV_TYPESAFE_CREDENTIAL_REF)))?.value,
  )
  let jevRegistration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
  let bambooRegistration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
  let disposed = false
  let refreshEpoch = 0
  ctx.effect(() => () => {
    disposed = true
    refreshEpoch++
  })
  const refresh = async (): Promise<void> => {
    if (disposed) return
    const epoch = ++refreshEpoch
    let bambooConfigured = false
    try {
      bambooConfigured = (
        await ctx.credentials.describe(credentialRef(BAMBOO_STARTLUX_CREDENTIAL_REF))
      ).configured
    } catch (error) {
      // An unavailable credential store cannot advertise a usable route.
      bambooConfigured = false
    }
    let jevConfigured = false
    try {
      jevConfigured = (await ctx.credentials.describe(credentialRef(JEV_TYPESAFE_CREDENTIAL_REF)))
        .configured
    } catch (error) {
      // Credential-store failure must not advertise the personal route.
      jevConfigured = false
    }
    if (disposed || epoch !== refreshEpoch) return
    const jevRoutes = jevConfigured ? [JEV_TYPESAFE_MODEL.provider] : []
    if (jevRegistration) jevRegistration.replace(jevRoutes)
    else if (jevRoutes.length) jevRegistration = ctx.llm.registerAdapter(jevRoutes, jevAdapter)
    const bambooRoutes = bambooConfigured ? [BAMBOO_STARTLUX_MODEL.provider] : []
    if (bambooRegistration) bambooRegistration.replace(bambooRoutes)
    else if (bambooRoutes.length)
      bambooRegistration = ctx.llm.registerAdapter(bambooRoutes, bambooAdapter)
  }
  ctx.on('loader/volatile-update', () => void refresh(), { global: true })
  ctx.on(
    'credentials/reference-updated',
    (ref) => {
      if ([BAMBOO_STARTLUX_CREDENTIAL_REF, JEV_TYPESAFE_CREDENTIAL_REF].includes(String(ref)))
        void refresh()
    },
    { global: true },
  )
  await refresh()
}
