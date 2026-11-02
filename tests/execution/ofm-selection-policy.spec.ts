import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { adapterFor, defaultHarness } from '../../src/execution/host/adapters/index.ts'
import {
  defaultExecutionCatalog,
  ExecutionCatalogStore,
  normalizeCatalog,
} from '../../src/execution/host/catalog.ts'
import { ExecutionModelResolver } from '../../src/execution/host/execution-models.ts'
import {
  isHiddenOfmSelection,
  OFM_CLIENT_REJECTED_MODELS,
  OFM_OPENCODE_DIRECTORY_ONLY_MODELS,
  OFM_OPENCODE_OFFICIAL_FREE_MODELS,
  officialOpenCodeModel,
} from '../../src/execution/host/ofm-source/selection-policy.ts'
import { OFM_PINNED_HARNESS_MODELS } from '../../src/execution/host/ofm-source/provider.ts'
import { ofmModelReadiness } from '../../src/execution/host/ofm-source/readiness.ts'
import { OPENCODE_OFM_MODELS } from '../../src/execution/host/adapters/opencode/opencode-models.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opl-big-pickle-'))
  roots.push(dir)
  return dir
}

/**
 * The OpenCode free-directory lanes this round could pair: each is published by the owning
 * OFM plugin's live free lane, so an exact `our-free-model` combination exists to bind.
 */
const NEW_OPENCODE_FREE_LANES = ['beam-free', 'nemotron-3.5-super-vl-free', 'glm-5.3-flash-free']

const BIG_PICKLE = { provider: 'our-free-model', model: 'big-pickle' } as const
const BIG_PICKLE_AUTO = 'auto:["our-free-model","big-pickle"]'

it('preserves saved defaults and disabled automatic routes across recommendation migration', async () => {
  const store = new ExecutionCatalogStore(await workspace())
  try {
    const catalog = defaultExecutionCatalog()
    catalog.combinations.push(
      {
        id: BIG_PICKLE_AUTO,
        name: 'Old route',
        modelRef: BIG_PICKLE,
        harnessRef: 'dsh',
        permissionPolicy: 'workspace',
        isDefault: true,
        enabled: false,
        autoEnabled: false,
        autoEnabledDisabled: true,
      },
      {
        id: 'my-pi-route',
        name: 'My route',
        modelRef: { provider: 'our-free-model', model: 'liquid/lfm-2.5-2.6b:free' },
        harnessRef: 'dsh',
        permissionPolicy: 'read-only',
        isDefault: true,
        enabled: true,
      },
    )
    await store.set(catalog)
    const ctx = {
      get: () => undefined,
      llm: {
        listProviders: () => [{ id: 'our-free-model', name: 'OFM' }],
        listConfigurableProviders: () => [],
        listModels: async () =>
          [BIG_PICKLE.model, 'liquid/lfm-2.5-2.6b:free', 'kilo-auto/free', 'unknown-model'].map(
            (id) => ({ id }),
          ),
      },
    }
    const resolver = new ExecutionModelResolver(ctx as never, store)
    for (let read = 0; read < 2; read++) {
      const result = await resolver.resolve()
      expect(result.combinations.find((item) => item.id === BIG_PICKLE_AUTO)).toMatchObject({
        harnessRef: 'dsh',
        permissionPolicy: 'workspace',
        enabled: false,
        autoEnabledDisabled: true,
        generated: false,
      })
      expect(
        result.combinations.filter((item) => item.modelRef.model === 'liquid/lfm-2.5-2.6b:free'),
      ).toEqual([
        expect.objectContaining({
          id: 'my-pi-route',
          harnessRef: 'dsh',
          permissionPolicy: 'read-only',
        }),
      ])
      expect(
        result.combinations.filter((item) => item.modelRef.model === 'kilo-auto/free'),
      ).toEqual([])
      expect(result.recommendations).toContainEqual(expect.objectContaining({ harnessRef: 'kilo' }))
      expect(result.combinations.some((item) => item.modelRef.model === 'unknown-model')).toBe(
        false,
      )
    }
    expect(
      (await store.get()).combinations.find((item) => item.id === BIG_PICKLE_AUTO),
    ).toMatchObject({ harnessRef: 'dsh', enabled: false, permissionPolicy: 'workspace' })
  } finally {
    await store.dispose()
  }
})

it('requires the OFM lane to be enabled before its listed model can enable a combination', () => {
  const ref = { provider: 'our-free-model', model: 'big-pickle' }
  const summary = (forward: object, route: string | null = 'our-free-model') => ({
    catalog: [{ id: ref.model, route }],
    settings: { enabled: true, forward },
  })
  expect(ofmModelReadiness(summary({ enabled: false, running: false }), ref, true)).toMatchObject({
    available: false,
  })
  expect(ofmModelReadiness(summary({ enabled: true, running: false }), ref, true)).toMatchObject({
    available: false,
  })
  expect(
    ofmModelReadiness(summary({ enabled: true, running: true }, null), ref, true),
  ).toMatchObject({ available: false })
  expect(ofmModelReadiness(summary({ enabled: true, running: true }), ref, true)).toEqual({
    available: true,
  })
  expect(
    ofmModelReadiness(
      {
        ...summary({ enabled: true, running: true }),
        membership: { 'our-free-model': ['other-model'] },
      },
      ref,
      true,
    ),
  ).toMatchObject({ available: false, reason: 'OFM 当前可用目录未包含此模型' })
  // A model carried by DSH itself does not require the external-forward listener.
  expect(ofmModelReadiness(summary({ enabled: false, running: false }), ref, false)).toEqual({
    available: true,
  })
})

it('disables persisted automatic combinations whose vendor model is no longer ready', async () => {
  const ready = { provider: 'our-free-model', model: 'moonshotai/kimi-k3' }
  const stopped = { provider: 'our-free-model', model: 'moonshotai/kimi-k2.6' }
  const catalog = defaultExecutionCatalog()
  catalog.combinations.push(
    {
      id: 'auto:' + JSON.stringify(['our-free-model', ready.model]),
      name: 'Ready + Kimi Code',
      modelRef: ready,
      harnessRef: 'kimi-code',
      permissionPolicy: 'read-only',
      isDefault: true,
      enabled: true,
      generated: true,
    },
    {
      id: 'auto:' + JSON.stringify(['our-free-model', stopped.model]),
      name: 'Stopped + Kimi Code',
      modelRef: stopped,
      harnessRef: 'kimi-code',
      permissionPolicy: 'read-only',
      isDefault: true,
      enabled: true,
      generated: true,
    },
  )
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: ready.model }, { id: stopped.model }],
    },
  }
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(
    ctx as never,
    store as never,
    undefined,
    async () => ({
      catalog: [
        { id: ready.model, route: 'our-free-model' },
        { id: stopped.model, route: null },
      ],
      settings: { enabled: true, forward: { enabled: true, running: true } },
    }),
  ).resolve()
  expect(resolved.combinations.find((item) => item.modelRef.model === ready.model)).toMatchObject({
    enabled: true,
  })
  expect(resolved.combinations.find((item) => item.modelRef.model === stopped.model)).toMatchObject(
    {
      enabled: false,
    },
  )
})

it('does not reopen an automatic combination after the user disables it', async () => {
  const ref = { provider: 'our-free-model', model: 'moonshotai/kimi-k3' }
  const catalog = defaultExecutionCatalog()
  catalog.combinations.push({
    id: 'auto:' + JSON.stringify(['our-free-model', ref.model]),
    name: 'Ready + Kimi Code',
    modelRef: ref,
    harnessRef: 'kimi-code',
    permissionPolicy: 'read-only',
    isDefault: true,
    enabled: false,
    generated: false,
    autoEnabled: false,
    autoEnabledDisabled: true,
  })
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: ref.model }],
    },
  }
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(
    ctx as never,
    store as never,
    undefined,
    async () => ({
      catalog: [{ id: ref.model, route: 'our-free-model' }],
      settings: { enabled: true, forward: { enabled: true, running: true } },
    }),
  ).resolve()
  expect(resolved.combinations.find((item) => item.modelRef.model === ref.model)).toMatchObject({
    enabled: false,
    autoEnabledDisabled: true,
  })
  expect(
    resolved.combinations.filter(
      (item) => item.modelRef.model === ref.model && item.id.startsWith('auto:'),
    ),
  ).toHaveLength(1)
})

it('distinguishes removed OFM references from a failed directory read and preserves saved choices', async () => {
  const ref = { provider: 'our-free-model', model: 'moonshotai/kimi-k3' }
  const store = new ExecutionCatalogStore(await workspace())
  const saved = defaultExecutionCatalog()
  saved.combinations.push({
    id: 'saved-kimi',
    name: 'My Kimi',
    modelRef: ref,
    harnessRef: 'kimi-code',
    enabled: true,
    isDefault: true,
    permissionPolicy: 'full-access',
  })
  await store.set(saved)
  let fail = false
  const ctx = {
    get: () => undefined,
    llm: { listProviders: () => [], listConfigurableProviders: () => [] },
  }
  const resolver = new ExecutionModelResolver(ctx as never, store, undefined, async () => {
    if (fail) throw Error('unavailable')
    return { catalog: [], settings: { enabled: true, forward: { enabled: true, running: true } } }
  })
  try {
    const missing = await resolver.resolve()
    expect(missing.models.find((item) => item.ref.model === ref.model)).toMatchObject({
      available: false,
      source: 'Our Free Model',
      unavailableKind: 'catalog-missing',
      reason: 'OFM 当前目录已移除此模型，保留原组合配置',
    })
    expect(missing.recommendations?.some((item) => item.modelRef.model === ref.model)).toBe(false)
    fail = true
    const unknown = await resolver.resolve()
    expect(unknown.models.find((item) => item.ref.model === ref.model)).toMatchObject({
      available: false,
      unavailableKind: 'unconfirmed',
    })
    expect((await store.get()).combinations.find((item) => item.id === 'saved-kimi')).toEqual(
      saved.combinations.at(-1),
    )
  } finally {
    await store.dispose()
  }
})

it('does not interpret an incomplete OFM response as model removal', () => {
  expect(ofmModelReadiness({ settings: { enabled: true } }, BIG_PICKLE)).toMatchObject({
    available: false,
    unavailableKind: 'unconfirmed',
  })
})

it('pins MiniMax Flash free to OpenCode without folding its Kilo lane into the direct route', () => {
  const direct = 'minimax-m3.1-flash-free'
  const kilo = 'minimax/minimax-m3.1-flash:free'
  expect(officialOpenCodeModel({ provider: 'our-free-model', model: direct })).toBe(
    'opencode/' + direct,
  )
  expect(officialOpenCodeModel({ provider: 'our-free-model', model: kilo })).toBeUndefined()
  for (const model of [direct, kilo]) {
    expect(OPENCODE_OFM_MODELS).toContain(model)
    expect(OFM_PINNED_HARNESS_MODELS.opencode).toContain(model)
  }
})

it('keeps Kilo-channel Nemotron 3 Super on Kilo instead of OpenCode', () => {
  const ref = { provider: 'our-free-model', model: 'nvidia/nemotron-3-super-120b-a12b:free' }
  expect(OPENCODE_OFM_MODELS).not.toContain(ref.model)
  expect(OFM_PINNED_HARNESS_MODELS.opencode).not.toContain(ref.model)
  expect(OFM_PINNED_HARNESS_MODELS.kilo).toContain(ref.model)
  expect(defaultHarness(ref)).toBe('kilo')
  expect(adapterFor('kilo', ref)?.id).toBe('kilo')
  expect(adapterFor('opencode', ref)).toBeUndefined()
})

it('migrates a saved Nemotron OpenCode pairing to Kilo', async () => {
  const catalog = defaultExecutionCatalog()
  catalog.combinations.push({
    id: 'legacy-nemotron-opencode',
    name: 'Nemotron 3 Super + OpenCode',
    modelRef: { provider: 'our-free-model', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
    harnessRef: 'opencode',
    permissionPolicy: 'workspace',
    isDefault: false,
    enabled: true,
  })
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
    set: async (next: typeof catalog) => next,
  }
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'OFM' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'nvidia/nemotron-3-super-120b-a12b:free' }],
    },
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  expect(resolved.combinations).toContainEqual(
    expect.objectContaining({
      id: 'legacy-nemotron-opencode',
      name: 'Kilo Nemotron 3 Super + Kilo Code',
      harnessRef: 'kilo',
    }),
  )
})
const QUALIFICATION_AUTO = 'auto:["our-free-model","opl-qualification-free"]'

it('hides rejected OFM lanes and saved combinations after legacy cleanup, without hiding other sources', async () => {
  const stored = defaultExecutionCatalog()
  stored.combinations[0]!.name = 'DeepSeek + DSH'
  for (const provider of ['our-free-model', 'our-free-model-region'])
    for (const model of OFM_CLIENT_REJECTED_MODELS)
      stored.combinations.push({
        id: provider + ':' + model,
        name: model,
        modelRef: { provider, model },
        harnessRef: 'opencode',
        permissionPolicy: 'workspace',
        isDefault: true,
        enabled: true,
      })
  const models = [
    ...OFM_CLIENT_REJECTED_MODELS,
    'stepfun/step-5-preview-free',
    'nvidia/nemotron-3.5-lightning:free',
    'kilo-auto/free',
    'nvidia/nemotron-3.5-super-vl:free',
  ]
  const providers = ['our-free-model', 'our-free-model-region', 'custom']
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => providers.map((id) => ({ id, name: id })),
      listConfigurableProviders: () => [],
      listModels: async () => models.map((id) => ({ id })),
    },
  }
  const store = {
    get: async () => structuredClone(stored),
    cleanLegacyCombinations: async () => {
      const copy = structuredClone(stored)
      copy.combinations[0]!.name = 'DeepSeek'
      return copy
    },
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  for (const provider of providers) {
    const ids = resolved.models.filter((m) => m.ref.provider === provider).map((m) => m.ref.model)
    for (const model of OFM_CLIENT_REJECTED_MODELS)
      expect(ids.includes(model)).toBe(provider === 'custom')
    expect(ids).toContain('stepfun/step-5-preview-free')
    expect(ids).toContain('nvidia/nemotron-3.5-lightning:free')
  }
  expect(
    resolved.combinations
      .filter((c) => c.modelRef.provider.startsWith('our-free-model'))
      .every((c) => !OFM_CLIENT_REJECTED_MODELS.includes(c.modelRef.model)),
  ).toBe(true)
  expect(stored.combinations).toHaveLength(6)
})

it('offers the exact supported channel recommendation without automatically adding it', async () => {
  const catalog = defaultExecutionCatalog()
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'nvidia/nemotron-3.5-super-vl:free' }],
    },
  }
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  expect(
    resolved.combinations.filter(
      (item) => item.modelRef.model === 'nvidia/nemotron-3.5-super-vl:free',
    ),
  ).toEqual([])
  expect(
    resolved.combinations.some(
      (item) =>
        item.modelRef.model === 'nvidia/nemotron-3.5-super-vl:free' &&
        item.harnessRef === 'opencode',
    ),
  ).toBe(false)
  expect(
    resolved.models.find((item) => item.ref.model === 'nvidia/nemotron-3.5-super-vl:free'),
  ).toMatchObject({ source: 'Our Free Model' })
})

it('keeps Nemotron Super VL in the OFM channel while using the OpenCode harness', async () => {
  expect(
    officialOpenCodeModel({
      provider: 'our-free-model',
      model: 'nvidia/nemotron-3.5-super-vl:free',
    }),
  ).toBeUndefined()
})

it('routes the new OpenCode free-directory lanes to the CLI free provider, not to an alias', () => {
  for (const model of NEW_OPENCODE_FREE_LANES) {
    // The wire value is the directory's own `opencode/<id>`; the DSH provider stays OFM.
    expect(officialOpenCodeModel({ provider: 'our-free-model', model })).toBe('opencode/' + model)
    expect(officialOpenCodeModel({ provider: 'our-free-model-region', model })).toBeUndefined()
    expect(officialOpenCodeModel({ provider: 'custom', model })).toBeUndefined()
  }
  // The provider-qualified twin is a different route and is never rewritten into the bare
  // free lane; an earlier revision aliased it and the branch deliberately stopped.
  expect(
    officialOpenCodeModel({
      provider: 'our-free-model',
      model: 'nvidia/nemotron-3.5-super-vl:free',
    }),
  ).toBeUndefined()
})

it('routes only lanes the OpenCode adapter itself declares, and keeps them in the picker', () => {
  for (const model of OFM_OPENCODE_OFFICIAL_FREE_MODELS) {
    expect(OPENCODE_OFM_MODELS).toContain(model)
    expect(isHiddenOfmSelection({ provider: 'our-free-model', model })).toBe(false)
  }
  for (const model of NEW_OPENCODE_FREE_LANES) expect(OPENCODE_OFM_MODELS).toContain(model)
})

it('never routes or re-admits an excluded lane through the free-provider mapping', () => {
  for (const model of ['jev-1.13-free', 'nvidia/nemotron-3.5-content-safety:free']) {
    expect(officialOpenCodeModel({ provider: 'our-free-model', model })).toBeUndefined()
    expect(isHiddenOfmSelection({ provider: 'our-free-model', model })).toBe(true)
    expect(OPENCODE_OFM_MODELS).not.toContain(model)
  }
  // GPT-OSS belongs to the Codex pairing only; OpenCode must not claim it either.
  expect(OPENCODE_OFM_MODELS).not.toContain('openai/gpt-oss-20b')
})

it('keeps Big Pickle manually pairable with OpenCode without treating it as a vendor default', () => {
  // The owning plugin publishes the exact `our-free-model` lane; the official directory
  // serves it as `opencode/big-pickle` on Chat Completions. Nothing is aliased.
  expect(officialOpenCodeModel(BIG_PICKLE)).toBe('opencode/big-pickle')
  expect(OPENCODE_OFM_MODELS).toContain('big-pickle')
  expect(OFM_OPENCODE_OFFICIAL_FREE_MODELS).toContain('big-pickle')
  expect(OFM_PINNED_HARNESS_MODELS.opencode).toContain('big-pickle')
  expect(isHiddenOfmSelection(BIG_PICKLE)).toBe(false)
  // The OpenCode adapter can run it when the user explicitly chooses that pairing.
  expect(adapterFor('opencode', BIG_PICKLE)?.id).toBe('opencode')
  expect(defaultHarness(BIG_PICKLE)).toBe('opencode')
  expect(
    officialOpenCodeModel({ provider: 'our-free-model-region', model: 'big-pickle' }),
  ).toBeUndefined()
})

it('uses OpenCode for Flint through the registered OFM route', () => {
  const ref = { provider: 'our-free-model', model: 'flint-40b-free' }
  expect(officialOpenCodeModel(ref)).toBe('opencode/flint-40b-free')
  expect(OPENCODE_OFM_MODELS).toContain(ref.model)
  expect(OFM_PINNED_HARNESS_MODELS.opencode).toContain(ref.model)
  expect(isHiddenOfmSelection(ref)).toBe(false)
  expect(defaultHarness(ref)).toBe('opencode')
})

it('binds Big Pickle to OpenCode while keeping the OFM source and its real id', async () => {
  const catalog = defaultExecutionCatalog()
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'big-pickle' }],
    },
  }
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  expect(resolved.models.find((item) => item.ref.model === 'big-pickle')).toMatchObject({
    ref: { provider: 'our-free-model', model: 'big-pickle' },
    source: 'OpenCode 官方免费通道',
    available: true,
  })
  const combinations = resolved.combinations.filter((item) => item.modelRef.model === 'big-pickle')
  expect(combinations).toEqual([])
  expect(resolved.recommendations).toContainEqual(
    expect.objectContaining({ harnessRef: 'opencode' }),
  )
})

it('drops a generated Big Pickle DSH row before it can be persisted', () => {
  const catalog = defaultExecutionCatalog()
  catalog.combinations.push({
    id: BIG_PICKLE_AUTO,
    name: 'Big Pickle + DSH',
    modelRef: { provider: 'our-free-model', model: 'big-pickle' },
    harnessRef: 'dsh',
    permissionPolicy: 'read-only',
    isDefault: false,
    enabled: true,
    generated: true,
  })
  // The normal save/load path never writes a generated row; the persisted stale row is the
  // separate migration case below.
  expect(normalizeCatalog(catalog).combinations.some((item) => item.id === BIG_PICKLE_AUTO)).toBe(
    false,
  )
})

it('replaces obsolete automatic routes while retaining user routes', async () => {
  const dir = await workspace()
  const store = new ExecutionCatalogStore(dir)
  try {
    const catalog = defaultExecutionCatalog()
    catalog.combinations.push(
      {
        id: BIG_PICKLE_AUTO,
        name: 'Big Pickle + DSH',
        modelRef: { provider: 'our-free-model', model: 'big-pickle' },
        harnessRef: 'dsh',
        // An automatic row that reached disk (edited, or written by an older release)
        // carries no `generated` flag here. It must still be treated as stale.
        permissionPolicy: 'read-only',
        isDefault: true,
        enabled: true,
      },
      {
        id: 'user-big-pickle-dsh',
        name: 'My Big Pickle DSH route',
        modelRef: { provider: 'our-free-model', model: 'big-pickle' },
        harnessRef: 'dsh',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
      {
        id: QUALIFICATION_AUTO,
        name: 'Qualification + DSH',
        modelRef: { provider: 'our-free-model', model: 'opl-qualification-free' },
        harnessRef: 'dsh',
        permissionPolicy: 'read-only',
        isDefault: true,
        enabled: true,
      },
    )
    await store.set(catalog)

    const ctx = {
      get: () => undefined,
      llm: {
        listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
        listConfigurableProviders: () => [],
        listModels: async () => [{ id: 'big-pickle' }, { id: 'opl-qualification-free' }],
      },
    }
    const resolved = await new ExecutionModelResolver(ctx as never, store).resolve()
    const bigPickle = resolved.combinations.filter((item) => item.modelRef.model === 'big-pickle')
    expect(bigPickle.some((item) => item.id === BIG_PICKLE_AUTO)).toBe(false)
    expect(bigPickle.filter((item) => item.harnessRef === 'opencode')).toHaveLength(0)
    // A user-created route and another OFM model's automatic row are untouched.
    expect(bigPickle.find((item) => item.id === 'user-big-pickle-dsh')).toMatchObject({
      name: 'My Big Pickle DSH route',
      harnessRef: 'dsh',
      permissionPolicy: 'workspace',
    })
    expect(resolved.combinations.some((item) => item.id === QUALIFICATION_AUTO)).toBe(false)

    // The migrated route and the removal of the unsupported automatic row survive reload.
    const saved = JSON.parse(await readFile(store.filename, 'utf8'))
    expect(saved.combinations.some((item: any) => item.id === BIG_PICKLE_AUTO)).toBe(false)
    expect(saved.combinations.some((item: any) => item.id === 'user-big-pickle-dsh')).toBe(true)
    expect(saved.combinations.some((item: any) => item.id === QUALIFICATION_AUTO)).toBe(false)
  } finally {
    await store.dispose()
  }
})

it('records the remaining directory-only ids as refused instead of inventing an OFM lane', () => {
  // `exo-free` has no live free lane and `ll-alpha-free` is refused upstream for any
  // client that is not OpenCode itself. Big Pickle was reclassified on 2026-10-19 and is
  // asserted through the positive mapping above, not here.
  expect(OFM_OPENCODE_DIRECTORY_ONLY_MODELS).toEqual(['exo-free', 'll-alpha-free'])
  for (const model of OFM_OPENCODE_DIRECTORY_ONLY_MODELS) {
    expect(OPENCODE_OFM_MODELS).not.toContain(model)
    expect(officialOpenCodeModel({ provider: 'our-free-model', model })).toBeUndefined()
    // Not hidden as an OFM exclusion either: the owner withholds the lane, it does not
    // ban the model id.
    expect(isHiddenOfmSelection({ provider: 'our-free-model', model })).toBe(false)
    // A same-named model from another source keeps its own decision.
    expect(officialOpenCodeModel({ provider: 'custom', model })).toBeUndefined()
  }
  // The source's own pinning table must refuse them too, so a later edit to the routing
  // list alone cannot make the lane callable.
  expect(OFM_PINNED_HARNESS_MODELS.opencode).not.toContain('exo-free')
  expect(OFM_PINNED_HARNESS_MODELS.opencode).not.toContain('ll-alpha-free')
})

it('keeps unknown and unavailable ids out of the OpenCode mapping', () => {
  for (const model of ['big-pickle-preview', 'unknown-model', 'exo-free', 'll-alpha-free']) {
    const ref = { provider: 'our-free-model', model }
    expect(officialOpenCodeModel(ref)).toBeUndefined()
    expect(OPENCODE_OFM_MODELS).not.toContain(model)
    expect(adapterFor('opencode', ref, undefined)).toBeUndefined()
    // The fallback is the native DSH loop, never a guessed OpenCode route.
    expect(defaultHarness(ref)).toBe('dsh')
  }
})

it('offers supported OpenCode channel recommendations without creating combinations', async () => {
  const catalog = defaultExecutionCatalog()
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => NEW_OPENCODE_FREE_LANES.map((id) => ({ id })),
    },
  }
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  for (const model of NEW_OPENCODE_FREE_LANES) {
    expect(resolved.models.find((item) => item.ref.model === model)).toMatchObject({
      source: 'OpenCode 官方免费通道',
    })
    const bound = resolved.combinations.filter(
      (item) => item.modelRef.provider === 'our-free-model' && item.modelRef.model === model,
    )
    expect(bound).toEqual([])
  }
})

it('does not treat every model supplied by the OFM plugin as a DSH official pairing', async () => {
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'opl-qualification-free' }],
    },
  }
  const catalog = defaultExecutionCatalog()
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  expect(
    resolved.combinations.filter((item) => item.modelRef.model === 'opl-qualification-free'),
  ).toEqual([])
})

it('offers only adapter-supported OpenCode, Kilo, and Pi pairings', async () => {
  const catalog = defaultExecutionCatalog()
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => [
        { id: 'big-pickle' },
        { id: 'kilo-auto/free' },
        { id: 'liquid/lfm-2.5-2.6b:free' },
      ],
    },
  }
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  expect(resolved.recommendations?.map((item) => item.harnessRef)).toEqual(
    expect.arrayContaining(['opencode', 'kilo', 'pi']),
  )
  for (const [model, harnessRef] of [
    ['big-pickle', 'opencode'],
    ['kilo-auto/free', 'kilo'],
    ['liquid/lfm-2.5-2.6b:free', 'pi'],
  ] as const) {
    const ref = { provider: 'our-free-model', model }
    expect(adapterFor(harnessRef, ref)?.id).toBe(harnessRef)
  }
})

it.each(['opencode/glm-5.3-flash-free', 'opencode/deepseek-v4.1-flash-free'])(
  'offers EAC %s with OpenCode while retaining its OFM attribution',
  async (model) => {
    const catalog = defaultExecutionCatalog()
    const ctx = {
      get: () => undefined,
      llm: {
        listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
        listConfigurableProviders: () => [],
        listModels: async () => [{ id: model }],
      },
    }
    const store = { get: async () => catalog, cleanLegacyCombinations: async () => catalog }
    const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
    expect(resolved.models.find((item) => item.ref.model === model)).toMatchObject({
      source: 'Our Free Model',
    })
    const combinations = resolved.combinations.filter((item) => item.modelRef.model === model)
    expect(combinations).toEqual([])
    expect(resolved.recommendations).toContainEqual(
      expect.objectContaining({ harnessRef: 'opencode' }),
    )
    expect(officialOpenCodeModel({ provider: 'our-free-model', model })).toBeUndefined()
    expect(OPENCODE_OFM_MODELS).toContain(model)
  },
)

it('omits empty default harness setups but retains an explicitly configured existing engine', () => {
  const fresh = defaultExecutionCatalog()
  for (const id of ['mimo-code', 'muse-code'])
    expect(fresh.harnesses.some((h) => h.id === id)).toBe(false)
  for (const id of ['opencode', 'step-code', 'pool'])
    expect(fresh.harnesses.some((h) => h.id === id)).toBe(true)
  fresh.harnesses.push({
    id: 'muse-code',
    name: 'Existing Muse',
    kind: 'acp',
    command: 'custom-muse',
  })
  expect(normalizeCatalog(fresh).harnesses.find((h) => h.id === 'muse-code')?.command).toBe(
    'custom-muse',
  )
})

it('offers an OpenCode-only MiMo lane without generating a vendor CLI combination', async () => {
  const catalog = defaultExecutionCatalog()
  catalog.harnesses.push({
    id: 'mimo-code',
    name: 'MiMo Code',
    kind: 'acp',
    command: 'mimo',
  })
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'OFM' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'mimo-v2.6-flash-free' }],
    },
  }
  const resolved = await new ExecutionModelResolver(
    ctx as never,
    { get: async () => catalog } as never,
  ).resolve()
  expect(resolved.ofmDiscovery).toContainEqual(
    expect.objectContaining({
      modelRef: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' },
      status: { kind: 'recommended', harness: 'opencode', label: '推荐 OpenCode' },
    }),
  )
  expect(resolved.combinations.some((item) => item.modelRef.model === 'mimo-v2.6-flash-free')).toBe(
    false,
  )
  expect(resolved.recommendations).toContainEqual(
    expect.objectContaining({
      modelRef: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' },
      harnessRef: 'opencode',
    }),
  )
  catalog.combinations.push({
    id: 'saved-mimo',
    name: 'Saved MiMo',
    modelRef: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' },
    harnessRef: 'opencode',
    permissionPolicy: 'read-only',
    isDefault: false,
    enabled: true,
    autoEnabled: false,
    autoEnabledDisabled: true,
  })
  const saved = await new ExecutionModelResolver(
    ctx as never,
    { get: async () => catalog } as never,
  ).resolve()
  expect(saved.recommendations).toContainEqual(expect.objectContaining({ harnessRef: 'opencode' }))
  expect(saved.combinations.filter((item) => item.id === 'saved-mimo')).toHaveLength(1)
})

it('projects a newly discovered OFM model into recommendations and selection names', async () => {
  const catalog = defaultExecutionCatalog()
  const ref = { provider: 'our-free-model', model: 'nvidia/nemotron-3-super-120b-a12b:free' }
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'OFM' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'known-model' }],
    },
  }
  const resolver = new ExecutionModelResolver(
    ctx as never,
    { get: async () => catalog } as never,
    undefined,
    async () => ({
      catalog: [{ id: ref.model, name: 'Kilo Nemotron 3 Super', route: 'our-free-model' }],
      settings: { enabled: true, forward: { enabled: true, running: true } },
    }),
  )
  const resolved = await resolver.resolve()
  expect(resolved.models).toContainEqual(
    expect.objectContaining({ ref, name: 'Kilo Nemotron 3 Super', available: true }),
  )
  expect(resolved.recommendations).toContainEqual(
    expect.objectContaining({
      modelRef: ref,
      harnessRef: 'kilo',
      name: 'Kilo Nemotron 3 Super + Kilo Code',
    }),
  )
  expect(resolved.ofmDiscovery).toContainEqual(
    expect.objectContaining({
      modelRef: ref,
      name: 'Kilo Nemotron 3 Super',
      status: { kind: 'recommended', harness: 'kilo', label: '推荐 Kilo Code' },
    }),
  )
})

it('removes generated OFM combinations only after a successful catalog omits them', async () => {
  const stale = { provider: 'our-free-model', model: 'nvidia/nemotron-3-super-120b-a12b:free' }
  const kept = { provider: 'our-free-model', model: 'user/kept-model' }
  const catalog = defaultExecutionCatalog()
  catalog.combinations.push(
    {
      id: 'auto:' + JSON.stringify([stale.provider, stale.model]),
      name: 'Kilo Nemotron 3 Super + Kilo Code',
      modelRef: stale,
      harnessRef: 'kilo',
      permissionPolicy: 'read-only',
      isDefault: true,
      enabled: true,
    },
    {
      id: 'user-kept-stale-ofm',
      name: 'User kept model',
      modelRef: kept,
      harnessRef: 'kilo',
      permissionPolicy: 'read-only',
      isDefault: true,
      enabled: true,
    },
  )
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async (
      predicate: (item: (typeof catalog.combinations)[number]) => boolean,
    ) => {
      catalog.combinations = catalog.combinations.filter((item) => !predicate(item))
      return catalog
    },
  }
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'OFM' }],
      listConfigurableProviders: () => [],
      listModels: async () => [],
    },
  }
  const resolved = await new ExecutionModelResolver(
    ctx as never,
    store as never,
    undefined,
    async () => ({
      catalog: [
        { id: stale.model, route: 'our-free-model' },
        { id: kept.model, route: 'our-free-model' },
      ],
      membership: { 'our-free-model': [kept.model] },
      settings: { enabled: true, forward: { enabled: true, running: true } },
    }),
  ).resolve()
  expect(resolved.combinations.some((item) => item.modelRef.model === stale.model)).toBe(false)
  expect(resolved.combinations.some((item) => item.modelRef.model === kept.model)).toBe(true)
})

it('retains live model projections and automatic ownership when pruning persisted OFM routes', async () => {
  const store = new ExecutionCatalogStore(await workspace())
  const catalog = defaultExecutionCatalog()
  const stale = { provider: 'our-free-model', model: 'moonshotai/kimi-k3' }
  const kept = { provider: 'our-free-model', model: 'moonshotai/kimi-k2.6' }
  const keptId = 'auto:' + JSON.stringify([kept.provider, kept.model])
  catalog.combinations.push(
    {
      id: 'auto:' + JSON.stringify([stale.provider, stale.model]),
      name: 'Removed Kimi',
      modelRef: stale,
      harnessRef: 'kimi-code',
      permissionPolicy: 'read-only',
      isDefault: true,
      enabled: true,
    },
    {
      id: keptId,
      name: 'Kimi K2.6 + Kimi Code',
      modelRef: kept,
      harnessRef: 'kimi-code',
      permissionPolicy: 'read-only',
      isDefault: true,
      enabled: true,
    },
  )
  await store.set(catalog)
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [
        { id: 'our-free-model', name: 'OFM' },
        { id: 'custom-provider', name: 'Custom' },
      ],
      listConfigurableProviders: () => [],
      listModels: async (provider: string) =>
        provider === 'custom-provider' ? [{ id: 'custom-model' }] : [],
    },
  }
  try {
    const resolved = await new ExecutionModelResolver(ctx as never, store, undefined, async () => ({
      catalog: [
        { id: stale.model, route: 'our-free-model' },
        { id: kept.model, route: 'our-free-model' },
      ],
      membership: { 'our-free-model': [kept.model] },
      settings: { enabled: true, forward: { enabled: true, running: true } },
    })).resolve()
    expect(resolved.models).toContainEqual(
      expect.objectContaining({
        ref: { provider: 'custom-provider', model: 'custom-model' },
        available: true,
      }),
    )
    expect(resolved.models.find((item) => item.ref.model === kept.model)).toMatchObject({
      available: true,
      source: 'Our Free Model',
    })
    expect(resolved.combinations.find((item) => item.id === keptId)).toMatchObject({
      enabled: true,
      generated: true,
    })
    expect(
      (await store.get()).combinations.some((item) => item.modelRef.model === stale.model),
    ).toBe(false)
  } finally {
    await store.dispose()
  }
})
