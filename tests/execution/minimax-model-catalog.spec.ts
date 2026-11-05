/**
 * MiniMax Code product surface: the two fixed combinations, as the native LLM
 * registry and the execution catalog must expose them.
 *
 * Everything asserted here is behavior a user can see: what the native model
 * picker advertises, what a selection resolves to, what happens to a model the
 * official account does not serve, and how an execution combination is paired
 * with the official `mcode` account. The fixtures are the real projection paths
 * — the real `LlmRuntime`, the real `MiniMaxCodeModelAdapter`, the real
 * `ExecutionCatalogStore`, `ExecutionModelResolver` and `SessionController.modelCatalog()` —
 * so a wrong product decision fails here rather than in a hand-built echo.
 *
 * Deliberately out of scope: the ACP `configureSession`/transport handshake
 * (the `session/set_config_option` round-trip that pins `thinkingEffort=max`)
 * and the HarnessService session bridging, which the core owns separately.
 */
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  MINIMAX_CODE_HARNESS,
  MINIMAX_CODE_PROVIDER,
  isMinimaxCodeModel,
  minimaxCodeAdapter,
  minimaxCodeCombinations,
  minimaxCodeLaunch,
  minimaxCodeModels,
} from '../../src/execution/host/adapters/minimax.ts'
import { executablePath } from '../../src/execution/host/harness-registry.ts'
import { MiniMaxCodeModelAdapter } from '../../src/execution/host/adapters/minimax-models.ts'
import { adapterFor, defaultHarness } from '../../src/execution/host/adapters/index.ts'
import {
  ExecutionCatalogStore,
  defaultExecutionCatalog,
  normalizeCatalog,
  type ExecutionCatalog,
} from '../../src/execution/host/catalog.ts'
import { ExecutionModelResolver } from '../../src/execution/host/execution-models.ts'
import { systemEnvironment } from '../../src/execution/host/adapters/environment.ts'
import { DSH_COMBINATION } from '../../src/execution/contracts/sessions.ts'
import { modelRefKey, type ModelRef } from '../../src/shared/models.ts'

/* ------------------------------------------------------------------ product surface */

/**
 * The two models the official account serves. Written as literals so a rename
 * in the adapter is a failing test rather than a silently retargeted one.
 */
const M3_FLASH = 'MiniMax-M3.1-Flash'
const M3 = 'MiniMax-M3'
const FIXED_MODELS: readonly string[] = [M3_FLASH, M3]
/** The provider route the official CLI account owns. */
const PROVIDER = MINIMAX_CODE_PROVIDER
/** The combination IDs the product exposes, in the format it exposes them. */
const FLASH_COMBINATION = MINIMAX_CODE_HARNESS + '/' + M3_FLASH
const M3_COMBINATION = MINIMAX_CODE_HARNESS + '/' + M3

/* ------------------------------------------------------------------ fixtures */

const cleanups: (() => Promise<unknown>)[] = []
const previousEnv = new Map<string, string | undefined>()
for (const name of [
  'MINIMAX_DATA_DIR',
  'MINIMAX_CODE_HOME',
  'PATH',
  'DSH_HOME',
  'USERPROFILE',
  'HOME',
])
  previousEnv.set(name, process.env[name])

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  for (const [name, previous] of previousEnv) {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

const temp = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A real LLM registry with the adapter registered through the public entry point. */
async function llmSurface(): Promise<Context & { llm: LlmRuntime }> {
  const ctx = new CordisContext() as Context & { llm: LlmRuntime }
  await ctx.plugin(LlmRuntime)
  cleanups.push(() => ctx.fiber.dispose())
  const dispose = ctx.llm.registerAdapter([PROVIDER], new MiniMaxCodeModelAdapter())
  cleanups.push(async () => dispose())
  return ctx
}

type ProbeResult = { available: boolean; reason?: string }

/**
 * What the live LLM registry looks like. The default is the Gateway route only;
 * `registered` additionally declares the official account provider, which is what
 * `src/suite/execution.ts` does through `ctx.llm.registerAdapter`.
 */
function registry(options: { registered: boolean; gatewayModels: ModelRef[] }): ModelRef[] {
  return options.registered
    ? [
        { provider: PROVIDER, model: M3_FLASH },
        { provider: PROVIDER, model: M3 },
        ...options.gatewayModels,
      ]
    : options.gatewayModels
}

/**
 * The seams `ExecutionModelResolver` actually reads:
 * no session, no transport, and no stored Gateway credential.
 */
function resolverContext(
  modelRefs: ModelRef[] = [{ provider: 'opl-gateway', model: 'deepseek-flash' }],
  providerIds: readonly string[] = ['opl-gateway'],
) {
  const credentialLookups: string[] = []
  const directory = [
    {
      provider: 'opl-gateway',
      displayName: 'OPL Gateway',
      settingsNs: 'opl-suite',
      settingsPath: ['gateway'],
      apiKeyEnv: 'OPL_GATEWAY_DEEPSEEK_API_KEY',
    },
  ]
  const names: Record<string, string> = {
    'opl-gateway': 'OPL Gateway',
    [PROVIDER]: 'MiniMax 官方账号（mcode）',
  }
  const ctx = {
    llm: {
      listProviders: () => providerIds.map((id) => ({ id, name: names[id] ?? id })),
      listConfigurableProviders: () => directory,
      listModels: async (provider: string) =>
        modelRefs
          .filter((ref) => ref.provider === provider)
          .map((ref) => ({ provider, id: ref.model, name: ref.model })),
    },
    // No stored Gateway credential: MiniMax must not inherit this state.
    credentials: {
      resolve: async (ref: unknown) => {
        credentialLookups.push(String(ref))
        return undefined
      },
    },
    settings: { describe: () => [] },
    get: (name: string) => (name === 'settings' ? { describe: () => [] } : undefined),
  }
  return { ctx, credentialLookups }
}

async function resolverFixture(
  options: {
    store?: ExecutionCatalogStore
    models?: ModelRef[]
    providers?: readonly string[]
    probe?: (ref: ModelRef) => Promise<ProbeResult>
  } = {},
) {
  const home = await temp('opl-minimax-catalog-')
  process.env.DSH_HOME = home
  const store = options.store ?? new ExecutionCatalogStore(home)
  cleanups.push(() => store.dispose())
  const { ctx, credentialLookups } = resolverContext(options.models, options.providers)
  const probes: ModelRef[] = []
  const probe =
    options.probe ??
    (async (): Promise<ProbeResult> => ({ available: false, reason: 'mcode 未安装或未登录' }))
  const resolver = new ExecutionModelResolver(ctx as unknown as Context, store, async (ref) => {
    probes.push(ref)
    return probe(ref)
  })
  return { home, store, resolver, probes, credentialLookups }
}

const entriesFor = (catalog: ExecutionCatalog, ref: ModelRef) =>
  catalog.models.filter((item) => modelRefKey(item.ref) === modelRefKey(ref))

const combinationsFor = (catalog: ExecutionCatalog, ref: ModelRef) =>
  catalog.combinations.filter((item) => modelRefKey(item.modelRef) === modelRefKey(ref))

/** The one combination a fixed model must have, failing loudly on a duplicate. */
function combinationOf(catalog: ExecutionCatalog, model: string) {
  const matches = catalog.combinations.filter((item) => item.modelRef.model === model)
  expect(matches, model + ' 固定组合数量').toHaveLength(1)
  return matches[0]!
}

/* ------------------------------------------------------------------ the adapter surface */

describe('MiniMax Code native model adapter', () => {
  it('advertises exactly the two official account models, with no other entry', async () => {
    const ctx = await llmSurface()
    expect(ctx.llm.listProviders()).toContainEqual({
      id: PROVIDER,
      name: 'MiniMax 官方账号（mcode）',
    })
    const models = await ctx.llm.listModels(PROVIDER)
    expect(models.map((model) => model.id)).toEqual([M3_FLASH, M3])
    for (const model of models) {
      expect(model.provider).toBe(PROVIDER)
      expect(model.name.trim()).not.toBe('')
    }
  })

  it('resolves the official effort levels and the thinking switch with their defaults', async () => {
    const ctx = await llmSurface()
    for (const model of FIXED_MODELS) {
      const resolved = await ctx.llm.resolveModelInfo(PROVIDER, model)
      expect(resolved.provider).toBe(PROVIDER)
      expect(resolved.id).toBe(model)
      expect(resolved.name.trim()).not.toBe('')
      expect(resolved.reasoning?.efforts.map((item) => item.id)).toEqual(
        model === M3_FLASH ? ['default', 'low', 'medium', 'high', 'xhigh', 'max'] : ['on', 'off'],
      )
      expect(resolved.reasoning?.defaultEffort).toBe(model === M3_FLASH ? 'max' : 'on')
    }
  })

  it('rejects a setting not supported by the selected model, before any dispatch', async () => {
    const ctx = await llmSurface()
    for (const model of FIXED_MODELS)
      await expect(
        ctx.llm.resolveCallConfig({
          provider: PROVIDER,
          model,
          reasoningEffort: (model === M3_FLASH ? 'off' : 'high') as never,
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })

  it('refuses a model the official account does not serve instead of retargeting it', async () => {
    const ctx = await llmSurface()
    for (const unknown of [
      'MiniMax-M2',
      'MiniMax-M3.1-Flash-Preview',
      'MiniMax-M3.1-Flash:v:',
      'deepseek-flash',
    ]) {
      const error = await ctx.llm.resolveModelInfo(PROVIDER, unknown).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(error, unknown).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe('UNKNOWN_MODEL')
    }
    // The refusal is not a route into another provider: nothing else is
    // registered, and an unknown model still fails rather than falling back.
    expect(ctx.llm.listProviders().map((item) => item.id)).toEqual([PROVIDER])
  })

  it('serves the native model catalog, which is the list a selection is gated on', async () => {
    const ctx = await llmSurface()
    await ctx.plugin(AgentDefaultModelConfig, { provider: PROVIDER, model: M3 })
    const controller = new SessionController(ctx, { nativeOpen: false })
    const catalog = await controller.modelCatalog()
    expect(catalog.default).toEqual({ provider: PROVIDER, model: M3 })
    expect(catalog.failures).toEqual([])
    expect(catalog.routableProviders).toEqual([PROVIDER])
    const group = catalog.groups.find((item) => item.id === PROVIDER)
    expect(group?.name).toBe('MiniMax 官方账号（mcode）')
    expect(group?.models.map((item) => item.id)).toEqual([M3_FLASH, M3])
    for (const model of group?.models ?? [])
      expect(model.reasoning?.defaultEffort).toBe(model.id === M3_FLASH ? 'max' : 'on')
  })
})

/* ------------------------------------------------------------------ the execution catalog */

describe('MiniMax Code execution catalog wiring', () => {
  it('pairs each official model with the mcode harness and generates no second route', async () => {
    const { resolver, probes, store, credentialLookups } = await resolverFixture({
      probe: async () => ({ available: true }),
    })
    const catalog = await resolver.resolve()

    // One entry and one combination per model: no mirrored Gateway provider, no
    // `auto:` duplicate beside the fixed combination.
    for (const model of FIXED_MODELS) {
      const ref = { provider: PROVIDER, model }
      expect(entriesFor(catalog, ref), model).toHaveLength(1)
      expect(combinationsFor(catalog, ref), model).toHaveLength(1)
    }
    expect(
      catalog.combinations
        .filter((item) => item.id.startsWith(MINIMAX_CODE_HARNESS + '/'))
        .map((item) => item.id),
    ).toEqual([FLASH_COMBINATION, M3_COMBINATION])
    expect(catalog.combinations.some((item) => item.id.startsWith('auto:'))).toBe(false)

    const flash = combinationOf(catalog, M3_FLASH)
    expect(flash).toMatchObject({
      id: FLASH_COMBINATION,
      name: M3_FLASH,
      harnessRef: MINIMAX_CODE_HARNESS,
      permissionPolicy: 'full-access',
      isDefault: true,
      enabled: true,
    })
    expect(flash.modelRef).toEqual({ provider: PROVIDER, model: M3_FLASH })
    const m3 = combinationOf(catalog, M3)
    expect(m3).toMatchObject({
      id: M3_COMBINATION,
      name: M3,
      harnessRef: MINIMAX_CODE_HARNESS,
    })
    expect(m3.modelRef).toEqual({ provider: PROVIDER, model: M3 })

    // A default route may not be attached to the DSH loop: DSH cannot serve an
    // account model that belongs to another CLI.
    expect(defaultHarness({ provider: PROVIDER, model: M3_FLASH })).toBe(MINIMAX_CODE_HARNESS)
    expect(defaultHarness({ provider: PROVIDER, model: M3 })).toBe(MINIMAX_CODE_HARNESS)
    for (const model of FIXED_MODELS)
      expect(adapterFor(MINIMAX_CODE_HARNESS, { provider: PROVIDER, model })?.id).toBe(
        MINIMAX_CODE_HARNESS,
      )
    expect(isMinimaxCodeModel({ provider: PROVIDER, model: M3 })).toBe(true)
    expect(isMinimaxCodeModel({ provider: 'opl-gateway', model: M3 })).toBe(false)

    // Exactly one probe per model: MiniMax availability is decided by the CLI
    // probe, never by the Gateway credential this fixture leaves unconfigured.
    expect(
      probes
        .filter((ref) => ref.provider === PROVIDER)
        .map((ref) => ref.model)
        .sort(),
    ).toEqual([...FIXED_MODELS].sort())
    for (const model of FIXED_MODELS)
      expect(catalog.models.find((item) => item.ref.model === model)).toMatchObject({
        available: true,
        source: 'MiniMax 官方账号（mcode）',
      })
    // No credential is ever resolved for an account model: the CLI owns its own
    // login, so availability never comes from a Gateway credential reference.
    expect(credentialLookups.filter((name) => name.includes('minimax'))).toEqual([])

    // A persisted catalog resolves to the same two routes: no duplicate appears
    // on a second pass, and the fixed pairs survive a reload.
    await store.set(catalog)
    const again = await resolver.resolve()
    expect(combinationsFor(again, { provider: PROVIDER, model: M3_FLASH })).toHaveLength(1)
    expect(combinationsFor(again, { provider: PROVIDER, model: M3 })).toHaveLength(1)
  })

  it('publishes the fixed combinations even when the official CLI is not reachable', async () => {
    const { resolver } = await resolverFixture({
      probe: async () => ({ available: false, reason: 'mcode 未安装或未登录' }),
    })
    const catalog = await resolver.resolve()
    for (const model of FIXED_MODELS) {
      expect(
        catalog.models.find((item) => item.ref.model === model),
        model,
      ).toMatchObject({
        available: false,
        reason: 'mcode 未安装或未登录',
        source: 'MiniMax 官方账号（mcode）',
      })
      const combinations = combinationsFor(catalog, { provider: PROVIDER, model })
      expect(
        combinations.map((item) => item.harnessRef),
        model,
      ).toEqual([MINIMAX_CODE_HARNESS])
      expect(
        combinations.some((item) => item.id.startsWith('auto:')),
        model,
      ).toBe(false)
      expect(combinations[0]).toMatchObject({ enabled: false })
    }
  })

  it('keeps MiniMax availability independent of Gateway credentials and other providers', async () => {
    // A machine with no Gateway credential at all and no other provider models:
    // the official account models must still be projected and still be usable.
    const { resolver } = await resolverFixture({
      models: [],
      probe: async () => ({ available: true }),
    })
    const catalog = await resolver.resolve()
    for (const model of FIXED_MODELS) {
      const entry = catalog.models.find((item) => item.ref.model === model)
      expect(entry, model).toMatchObject({ available: true, source: 'MiniMax 官方账号（mcode）' })
      expect(entry?.reason, model).toBeUndefined()
    }
    expect(catalog.combinations.some((item) => item.id.startsWith('auto:'))).toBe(false)
  })

  it('keeps the official CLI verdict when the account provider is registered', async () => {
    // The product path: `src/suite/execution.ts` registers `minimax-official`
    // through `ctx.llm.registerAdapter`, so `listProviders()`/`listModels()` do
    // return the two models. The default `configured` of a listed provider is
    // not a readiness verdict — the CLI probe owns availability, in both
    // directions.
    const registered = {
      models: registry({
        registered: true,
        gatewayModels: [{ provider: 'opl-gateway', model: 'deepseek-flash' }],
      }),
      providers: ['opl-gateway', PROVIDER],
    }
    const offline = await resolverFixture({
      ...registered,
      probe: async () => ({ available: false, reason: '官方 mcode 尚未登录' }),
    })
    const offlineCatalog = await offline.resolver.resolve()
    for (const model of FIXED_MODELS) {
      expect(
        offlineCatalog.models.find((item) => item.ref.model === model),
        model,
      ).toMatchObject({
        available: false,
        reason: '官方 mcode 尚未登录',
      })
    }
    expect(offlineCatalog.combinations.some((item) => item.id.startsWith('auto:'))).toBe(false)

    const online = await resolverFixture({
      ...registered,
      probe: async () => ({ available: true }),
    })
    const onlineCatalog = await online.resolver.resolve()
    for (const model of FIXED_MODELS) {
      expect(
        onlineCatalog.models.find((item) => item.ref.model === model),
        model,
      ).toMatchObject({
        available: true,
        source: 'MiniMax 官方账号（mcode）',
      })
      expect(
        onlineCatalog.models.find((item) => item.ref.model === model)?.reason,
        model,
      ).toBeUndefined()
    }
    expect(
      onlineCatalog.combinations
        .filter((item) => item.modelRef.provider === PROVIDER)
        .map((item) => item.id),
    ).toEqual([FLASH_COMBINATION, M3_COMBINATION])
    // No Gateway credential is consulted for an account model, even when the
    // provider is listed in the live registry.
    expect(online.credentialLookups.filter((name) => name.includes('minimax'))).toEqual([])
  })

  it('degrades safely when no external CLI probe is wired at all', async () => {
    // The resolver may only project an account model as usable through the CLI
    // probe; without one it must report the missing prerequisite, never assume
    // the Gateway can serve it.
    const { store } = await resolverFixture()
    const bare = new ExecutionModelResolver(resolverContext().ctx as unknown as Context, store)
    const catalog = await bare.resolve()
    for (const model of FIXED_MODELS) {
      expect(
        catalog.models.find((item) => item.ref.model === model),
        model,
      ).toMatchObject({
        available: false,
      })
    }
    expect(catalog.combinations.some((item) => item.id.startsWith('auto:'))).toBe(false)
  })

  it('projects the fixed combinations through the real adapter probe, never a Gateway key', async () => {
    // The composition the HarnessService installs: the resolver asks the real
    // `minimaxCodeAdapter.available`, which answers only from the official CLI
    // and its own login.
    const root = await temp('opl-minimax-probe-')
    const home = await temp('opl-minimax-probe-home-')
    await mkdir(join(home, '.minimax-code'), { recursive: true })
    process.env.MINIMAX_CODE_HOME = join(root, 'minimax-code')
    process.env.MINIMAX_DATA_DIR = join(root, 'data')
    process.env.PATH = join(root, 'empty-path')
    process.env.USERPROFILE = home
    process.env.HOME = home
    const { resolver } = await resolverFixture({
      probe: (ref) =>
        minimaxCodeAdapter.available(
          undefined as unknown as Context,
          {
            home: root,
            grokCommand: 'grok',
            nativeBridgePath: '',
          } as never,
        ),
    })
    const catalog = await resolver.resolve()
    for (const model of FIXED_MODELS) {
      const entry = catalog.models.find((item) => item.ref.model === model)
      expect(entry, model).toMatchObject({ available: false })
      expect((entry?.reason ?? '').length, model).toBeGreaterThan(0)
    }
    expect(catalog.combinations.some((item) => item.id.startsWith('auto:'))).toBe(false)
  })

  it('projects the same fixed prefixes the harness declares', async () => {
    const catalog = defaultExecutionCatalog()
    expect(catalog.harnesses.find((item) => item.id === MINIMAX_CODE_HARNESS)).toMatchObject({
      command: 'mcode',
      kind: 'acp',
    })
    expect(minimaxCodeCombinations().map((item) => item.combination)).toEqual([
      FLASH_COMBINATION,
      M3_COMBINATION,
    ])
    expect(minimaxCodeModels()).toEqual([
      { provider: PROVIDER, model: M3_FLASH },
      { provider: PROVIDER, model: M3 },
    ])
    for (const model of minimaxCodeModels()) expect(isMinimaxCodeModel(model)).toBe(true)
  })

  it('survives the catalog normalizer, which rejects a second default for one model', async () => {
    const { resolver, store } = await resolverFixture({
      probe: async () => ({ available: true }),
    })
    const catalog = await resolver.resolve()
    const persisted = normalizeCatalog(catalog)
    const defaults = persisted.combinations
      .filter((item) => item.isDefault && item.enabled)
      .map((item) => modelRefKey(item.modelRef))
    expect(new Set(defaults).size).toBe(defaults.length)
    expect(new Set(persisted.combinations.map((item) => item.id)).size).toBe(
      persisted.combinations.length,
    )
    // full-access is the permission the official CLI needs to be verifiable at all,
    // so it must survive a normalizer round-trip...
    for (const id of [FLASH_COMBINATION, M3_COMBINATION])
      expect(persisted.combinations.find((item) => item.id === id)?.permissionPolicy, id).toBe(
        'full-access',
      )
    // An unverified Harness cannot inherit this permission through a catalog edit.
    expect(() =>
      normalizeCatalog({
        ...catalog,
        combinations: catalog.combinations.map((item) =>
          item.id === FLASH_COMBINATION ? { ...item, harnessRef: 'antigravity' } : item,
        ),
      }),
    ).toThrow(/full-access/)
    // The write-back the resolver performs is the same shape the store reloads.
    await store.set(catalog)
    const reloaded = await store.get()
    expect(reloaded.combinations.map((item) => item.id).sort()).toEqual(
      catalog.combinations.map((item) => item.id).sort(),
    )
    expect(
      reloaded.combinations
        .filter((item) => item.modelRef.provider === PROVIDER)
        .every(
          (item) =>
            item.id.startsWith(MINIMAX_CODE_HARNESS + '/') ===
            (item.permissionPolicy === 'full-access'),
        ),
    ).toBe(true)
  })

  it('declares full-access only for the mcode combinations, and never widens DSH', async () => {
    const { resolver, store } = await resolverFixture({ probe: async () => ({ available: true }) })
    const catalog = await resolver.resolve()
    const permissions = new Map(
      catalog.combinations.map((item) => [item.id, item.permissionPolicy]),
    )
    expect(permissions.get(FLASH_COMBINATION)).toBe('full-access')
    expect(permissions.get(M3_COMBINATION)).toBe('full-access')
    // The native DSH route keeps its restricted policy: the mcode exception may
    // not leak into the loop this suite runs for every other model.
    expect(permissions.get(DSH_COMBINATION)).not.toBe('full-access')
    for (const item of catalog.combinations.filter((item) => item.modelRef.provider === PROVIDER))
      if (item.permissionPolicy === 'full-access')
        expect(item.harnessRef, item.id).toBe(MINIMAX_CODE_HARNESS)
    // A fixed MiniMax combination is never projected as a generated `auto:` route
    // (generated routes are read-only and belong to the DSH/native path).
    for (const item of catalog.combinations.filter((entry) => entry.modelRef.provider === PROVIDER))
      expect(item.generated, item.id).not.toBe(true)
    // The authorization is durable: a restart reloads the same policy from disk,
    // so a downgrade cannot reappear as a workspace task after the file round-trip.
    await store.set(catalog)
    const onDisk = JSON.parse(await readFile(join(store.filename), 'utf8')) as {
      combinations: { id: string; permissionPolicy: string }[]
    }
    for (const id of [FLASH_COMBINATION, M3_COMBINATION])
      expect(onDisk.combinations.find((item) => item.id === id)?.permissionPolicy, id).toBe(
        'full-access',
      )
  })
})

/* ------------------------------------------------------------------ the launch seam */

describe('MiniMax Code adapter routing seam', () => {
  /** Only an explicitly authorized full-access session may launch the official CLI. */
  const record = (model: string, sandbox = 'full-access') =>
    ({
      combination: MINIMAX_CODE_HARNESS + '/' + model,
      modelRef: { provider: PROVIDER, model },
      harnessRef: MINIMAX_CODE_HARNESS,
      cwd: process.cwd(),
      sandbox,
      acpSessionId: 'acp-session',
      turns: [],
    }) as never

  const options = (home: string) => ({ home, grokCommand: 'grok', nativeBridgePath: '' }) as never

  it('reports the missing official CLI without blaming a Gateway credential', async () => {
    // An empty PATH, an empty install root and an empty known root: the CLI
    // cannot be found, and the diagnosis may not point at the Gateway.
    const root = await temp('opl-minimax-missing-')
    const home = await temp('opl-minimax-home-')
    const bin = join(root, 'minimax-code')
    await mkdir(join(home, '.minimax-code'), { recursive: true })
    process.env.MINIMAX_CODE_HOME = bin
    process.env.PATH = join(root, 'empty-path')
    process.env.USERPROFILE = home
    process.env.HOME = home
    // The claim is only meaningful when the launcher really is unresolvable.
    expect(await executablePath('mcode', MINIMAX_CODE_HARNESS)).toBeUndefined()
    const status = await minimaxCodeAdapter.available(
      undefined as unknown as Context,
      options(root),
    )
    expect(status.available).toBe(false)
    expect(status.reason).toContain('mcode')
    // The diagnosis may name the CLI but never a credential problem: the account
    // login belongs to the official CLI and no Gateway key is involved.
    expect(status.reason).not.toMatch(/凭据|密钥|API ?Key|apiKey|未授权|未就绪/)
  })

  it('treats the official login as the gate and never reads a Gateway key', async () => {
    // `MINIMAX_DATA_DIR` is honored exclusively, so a missing auth file under it
    // means "not signed in" regardless of anything else on the machine.
    const root = await temp('opl-minimax-login-')
    const launcher = process.platform === 'win32' ? 'mcode.cmd' : 'mcode'
    const bin = join(root, 'minimax-code')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, launcher), '')
    await chmod(join(bin, launcher), 0o755)
    process.env.MINIMAX_CODE_HOME = bin
    process.env.PATH = bin
    process.env.MINIMAX_DATA_DIR = join(root, 'data')

    const signedOut = await minimaxCodeAdapter.available(
      undefined as unknown as Context,
      options(root),
    )
    expect(signedOut.available).toBe(false)
    expect(signedOut.reason).toContain('mcode login')
    expect(signedOut.reason).not.toMatch(/Gateway ?Key|OPL Gateway|网关/)

    process.env.MINIMAX_DATA_DIR = join(root, 'data2')
    await mkdir(join(root, 'data2', 'auth'), { recursive: true })
    await writeFile(join(root, 'data2', 'auth', 'auth.json'), '{}')
    expect(
      await minimaxCodeAdapter.available(undefined as unknown as Context, options(root)),
    ).toEqual({ available: true })
  })

  it('launches the official CLI in ACP mode with no bypass flag and only system environment', async () => {
    const root = await temp('opl-minimax-flags-')
    const bin = join(root, 'minimax-code')
    await mkdir(bin, { recursive: true })
    const launcher = join(bin, process.platform === 'win32' ? 'mcode.cmd' : 'mcode')
    await writeFile(launcher, '')
    await chmod(launcher, 0o755)
    process.env.MINIMAX_CODE_HOME = bin
    process.env.PATH = bin
    process.env.MINIMAX_DATA_DIR = join(root, 'data')
    const path = await executablePath('mcode', MINIMAX_CODE_HARNESS)
    expect(path).toBe(launcher)
    const prepared = await minimaxCodeAdapter.prepare!(
      undefined as unknown as Context,
      record(M3),
      options(root),
    )
    // The launcher is the official CLI, started in its ACP mode — directly, or
    // through `cmd.exe` for a Windows `.cmd` shim.
    const expected = minimaxCodeLaunch(path!)
    expect(prepared.command).toBe(expected.command)
    expect(prepared.args).toEqual(expected.args)
    const argv = [prepared.command, ...prepared.args].join(' ')
    expect(argv).toContain(path!)
    expect(argv).toContain('acp')
    // The authorization stays with the official CLI: the suite neither injects a
    // bypass flag nor overrides the CLI's own permission mode.
    expect(argv).not.toMatch(
      /--?danger|bypass|--?permission|permission-mode|--?sandbox|skip-?permission|--?y\b/i,
    )
    // The CLI owns its own account: the suite injects no key and copies no token.
    expect(Object.keys(prepared.env).sort()).toEqual(
      [
        ...new Set([
          ...Object.keys(systemEnvironment()),
          ...(process.platform === 'win32' ? ['MCODE_SHELL_PATH', 'SHELL'] : []),
        ]),
      ].sort(),
    )
    if (process.platform === 'win32') {
      expect(prepared.env.MCODE_SHELL_PATH).toMatch(/bash\.exe$/i)
      expect(prepared.env.SHELL).toBe(prepared.env.MCODE_SHELL_PATH)
    }
    expect(Object.keys(prepared.env).join(' ')).not.toMatch(/KEY|TOKEN|SECRET|AUTH/i)
    expect(prepared.env.MINIMAX_DATA_DIR).toBe(join(root, 'data'))
  })

  it('refuses to prepare a model outside the fixed combinations', async () => {
    const root = await temp('opl-minimax-refuse-')
    await expect(
      minimaxCodeAdapter.prepare!(
        undefined as unknown as Context,
        record('MiniMax-M2'),
        options(root),
      ),
    ).rejects.toThrow(/MiniMax Code/)
  })

  it('refuses to launch a restricted session, before the CLI is even looked up', async () => {
    // `mcode` cannot enforce a verifiable DSH read-only/workspace boundary, so the
    // suite must not start it for a restricted task — and must not silently widen
    // the request to full-access either. The refusal happens before any launcher
    // lookup, so it holds even on a machine with no CLI installed.
    const root = await temp('opl-minimax-restricted-')
    const home = await temp('opl-minimax-restricted-home-')
    await mkdir(join(home, '.minimax-code'), { recursive: true })
    process.env.MINIMAX_CODE_HOME = join(root, 'minimax-code')
    process.env.PATH = join(root, 'empty-path')
    process.env.USERPROFILE = home
    process.env.HOME = home
    expect(await executablePath('mcode', MINIMAX_CODE_HARNESS)).toBeUndefined()
    for (const sandbox of ['read-only', 'workspace']) {
      const error = await minimaxCodeAdapter.prepare!(
        undefined as unknown as Context,
        record(M3, sandbox),
        options(root),
      ).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(error, sandbox).toBeInstanceOf(Error)
      // The refusal names the permission problem, not a missing install or login.
      expect((error as Error).message, sandbox).toContain('full-access')
      expect((error as Error).message, sandbox).not.toMatch(/未找到|安装器|login/)
    }
  })
})

/* ------------------------------------------------------------------ the no-routing refusal */

describe('MiniMax model with no bound combination', () => {
  it('fails the call instead of streaming through another provider', async () => {
    const ctx = await llmSurface()
    const request: GenerateOptions = {
      provider: PROVIDER,
      model: M3,
      messages: [],
      sessionId: 'session-without-combination' as SessionId,
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    const failure = (chunks[0] as { reason: { failure: { code: string; message: string } } }).reason
      .failure
    expect(failure.code).toBe('MINIMAX_CODE_COMBINATION_REQUIRED')
    expect(failure.message).toContain('mcode')
  })

  it('shares its fixed model list with the harness adapter that owns the route', () => {
    for (const model of minimaxCodeCombinations()) {
      expect(FIXED_MODELS).toContain(model.model)
      expect(minimaxCodeAdapter.matches({ provider: PROVIDER, model: model.model })).toBe(true)
    }
    expect(minimaxCodeAdapter.matches({ provider: 'opl-gateway', model: M3 })).toBe(false)
  })
})
