import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ExecutionCatalogStore, defaultExecutionCatalog } from '../../src/execution/host/catalog.ts'
import { ExecutionModelResolver } from '../../src/execution/host/execution-models.ts'
import { combinationChoices } from '../../src/execution/client/combination-choices.ts'
import { selectableModels } from '../../src/execution/contracts/catalog.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const ref = { provider: 'our-free-model', model: 'moonshotai/kimi-k3' }
const saved = {
  id: 'saved-kimi',
  name: 'My Kimi',
  modelRef: ref,
  harnessRef: 'kimi-code',
  permissionPolicy: 'full-access' as const,
  isDefault: true,
  enabled: true,
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opl-ofm-discovery-'))
  roots.push(root)
  const state = { listed: false, enabled: true, failed: false, advertised: false }
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: ref.provider, name: 'OFM' }],
      listConfigurableProviders: () => [],
      listModels: async () => (state.advertised ? [{ id: ref.model }] : []),
    },
  }
  const read = async () => {
    if (state.failed) throw Error('OFM unavailable')
    return {
      catalog: state.listed ? [{ id: ref.model, route: ref.provider }] : [],
      settings: { enabled: state.enabled, forward: { enabled: true, running: true } },
    }
  }
  const resolve = (store: ExecutionCatalogStore) =>
    new ExecutionModelResolver(ctx as never, store, undefined, read).resolve()
  return { root, state, resolve }
}

it('a fresh installation does not discover removed models from adapter declarations', async () => {
  const { root, resolve } = await fixture()
  const store = new ExecutionCatalogStore(root)
  try {
    const catalog = await resolve(store)
    expect(catalog.ofmDiscovery).toEqual([])
    expect(catalog.models.some((item) => item.ref.model === ref.model)).toBe(false)
    expect(catalog.combinations.some((item) => item.modelRef.model === ref.model)).toBe(false)
  } finally {
    await store.dispose()
  }
})

it('does not expose an OFM virtual combo as a model or new-model discovery entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-ofm-combo-'))
  roots.push(root)
  const ref = { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' }
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'OFM' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'combo:recommended-free' }, { id: ref.model }],
    },
  }
  const store = new ExecutionCatalogStore(root)
  try {
    const catalog = await new ExecutionModelResolver(ctx as never, store, undefined, async () => ({
      catalog: [
        { id: 'combo:recommended-free', channel: 'combo' },
        { id: ref.model, route: 'our-free-model' },
      ],
      settings: { enabled: true, forward: { enabled: true, running: true } },
      membership: { main: [ref.model] },
    })).resolve()
    expect(catalog.models.some((item) => item.ref.model === 'combo:recommended-free')).toBe(false)
    expect(
      catalog.ofmDiscovery?.some((item) => item.modelRef.model === 'combo:recommended-free'),
    ).toBe(false)
  } finally {
    await store.dispose()
  }
})

it.each([true, false])(
  'keeps an enabled saved missing model in combinations alone when OFM enabled is %s',
  async (enabled) => {
    const { root, state, resolve } = await fixture()
    state.enabled = enabled
    state.advertised = true
    const store = new ExecutionCatalogStore(root)
    try {
      const input = defaultExecutionCatalog()
      input.combinations.push(saved)
      await store.set(input)
      const catalog = await resolve(store)
      expect(catalog.ofmDiscovery).toEqual([])
      expect(catalog.combinations.find((item) => item.id === saved.id)).toEqual(saved)
      expect(catalog.models.find((item) => item.ref.model === ref.model)).toMatchObject({
        available: false,
        unavailableKind: enabled ? 'catalog-missing' : 'disabled',
      })
      expect(combinationChoices(catalog).some((item) => item.modelRef.model === ref.model)).toBe(
        false,
      )
      expect(selectableModels(catalog.models).some((item) => item.ref.model === ref.model)).toBe(
        false,
      )
      expect((await store.get()).combinations.find((item) => item.id === saved.id)).toEqual(saved)
    } finally {
      await store.dispose()
    }
  },
)

it('keeps a removed choice disabled after persistence, restart, and relisting', async () => {
  const { root, state, resolve } = await fixture()
  let store = new ExecutionCatalogStore(root)
  try {
    const input = defaultExecutionCatalog()
    input.combinations.push(saved)
    await store.set(input)
    const missing = await resolve(store)
    await store.set({
      ...missing,
      combinations: missing.combinations.map((item) =>
        item.id === saved.id
          ? {
              ...item,
              enabled: false,
              generated: false,
              autoEnabled: false,
              autoEnabledDisabled: true,
            }
          : item,
      ),
    })
    await store.dispose()
    store = new ExecutionCatalogStore(root)
    const restarted = await resolve(store)
    expect(restarted.ofmDiscovery).toEqual([])
    expect(restarted.combinations.some((item) => item.enabled && item.id === saved.id)).toBe(false)
    expect(combinationChoices(restarted).some((item) => item.modelRef.model === ref.model)).toBe(
      false,
    )
    state.listed = true
    const relisted = await resolve(store)
    expect(relisted.ofmDiscovery).toContainEqual(
      expect.objectContaining({ modelRef: ref, available: true }),
    )
    expect(relisted.combinations.filter((item) => item.modelRef.model === ref.model)).toEqual([
      { ...saved, enabled: false, autoEnabled: false, autoEnabledDisabled: true },
    ])
    expect(
      combinationChoices(relisted).filter((item) => item.modelRef.model === ref.model),
    ).toMatchObject([{ id: saved.id, enabled: false }])
    expect((await store.get()).combinations.find((item) => item.id === saved.id)).toMatchObject({
      enabled: false,
      permissionPolicy: saved.permissionPolicy,
      name: saved.name,
    })
  } finally {
    await store.dispose()
  }
})

it('a failed directory read preserves saved choices and discovers only provider-advertised models', async () => {
  const { root, state, resolve } = await fixture()
  const store = new ExecutionCatalogStore(root)
  try {
    const input = defaultExecutionCatalog()
    input.combinations.push(saved)
    await store.set(input)
    state.failed = true
    let catalog = await resolve(store)
    expect(catalog.ofmDiscovery).toEqual([])
    expect(catalog.models.find((item) => item.ref.model === ref.model)).toMatchObject({
      available: false,
      unavailableKind: 'unconfirmed',
    })
    expect((await store.get()).combinations.find((item) => item.id === saved.id)).toEqual(saved)
    state.advertised = true
    catalog = await resolve(store)
    expect(catalog.ofmDiscovery).toContainEqual(
      expect.objectContaining({
        modelRef: ref,
        available: false,
        unavailableKind: 'unconfirmed',
      }),
    )
  } finally {
    await store.dispose()
  }
})
