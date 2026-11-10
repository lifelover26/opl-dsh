import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultExecutionCatalog,
  ExecutionCatalogStore,
  normalizeCatalog,
} from '../../src/execution/host/catalog.ts'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'opl-catalog-'))
  roots.push(dir)
  return dir
}
describe('combination authority', () => {
  it('persists references without a second model catalog', async () => {
    const dir = await root(),
      store = new ExecutionCatalogStore(dir),
      catalog = await store.get()
    catalog.models = [
      { ref: { provider: 'custom', model: 'a' }, name: 'A', source: 'custom', available: true },
    ]
    await store.set(catalog)
    const saved = JSON.parse(await readFile(store.filename, 'utf8'))
    expect(saved.models).toBeUndefined()
    expect(saved.connections).toBeUndefined()
    expect(saved.combinations[0]).not.toHaveProperty('connectionId')
  })
  it('migrates old same-model group references and preserves the original bytes', async () => {
    const dir = await root(),
      file = join(dir, 'profiles/desktop/execution-catalog.json')
    await mkdir(join(dir, 'profiles/desktop'), { recursive: true })
    const old = JSON.stringify({
      connections: [{ id: 'opl-gateway' }],
      models: [
        { id: 'ds', connectionId: 'opl-gateway', modelId: 'deepseek-flash', routeId: 'codex' },
      ],
      harnesses: [{ id: 'dsh', kind: 'dsh', name: 'DSH' }],
      combinations: [
        {
          id: 'custom',
          name: 'Custom',
          modelId: 'ds',
          connectionId: 'opl-gateway',
          harnessId: 'dsh',
          sandbox: 'read-only',
          isDefault: true,
          enabled: true,
        },
      ],
    })
    await writeFile(file, old)
    const catalog = await new ExecutionCatalogStore(dir).get()
    expect(catalog.combinations[0]?.modelRef).toEqual({
      provider: 'opl-gateway',
      model: 'codex::deepseek-flash',
    })
    expect(await readFile(file + '.v1.backup', 'utf8')).toBe(old)
  })
  it('allows defaults per model but rejects competing defaults for the same model', () => {
    const catalog = defaultExecutionCatalog()
    expect(normalizeCatalog(catalog).combinations).toHaveLength(2)
    catalog.combinations.push({ ...catalog.combinations[0]!, id: 'duplicate' })
    expect(() => normalizeCatalog(catalog)).toThrow('默认组合')
  })
  it('preserves the user stop marker across catalog saves', () => {
    const catalog = defaultExecutionCatalog()
    catalog.combinations[0] = {
      ...catalog.combinations[0]!,
      generated: false,
      autoEnabled: false,
      autoEnabledDisabled: true,
    }
    expect(normalizeCatalog(catalog).combinations[0]).toMatchObject({
      autoEnabled: false,
      autoEnabledDisabled: true,
    })
  })
  it('refuses removal of the native Harness', () => {
    const catalog = defaultExecutionCatalog()
    catalog.harnesses = []
    expect(() => normalizeCatalog(catalog)).toThrow('内置 DSH')
  })
})

describe('user model choices', () => {
  it('projects third-party models without inventing pairings and preserves custom defaults', async () => {
    const { ExecutionModelResolver } = await import('../../src/execution/host/execution-models.ts')
    const providers = [
      { id: 'our-free-model', name: 'Our Free Model' },
      { id: 'our-free-model-region', name: 'Our Free Model · region-limited' },
      { id: 'minimax', name: 'MiniMax' },
      { id: 'zcode', name: 'ZCode' },
    ]
    const models = ['plugin-model', 'combo:my-route']
    const catalog = defaultExecutionCatalog()
    catalog.combinations.push({
      id: 'user-default',
      name: 'My route',
      modelRef: { provider: 'our-free-model', model: 'plugin-model' },
      harnessRef: 'dsh',
      permissionPolicy: 'workspace',
      isDefault: true,
      enabled: true,
    })
    const ctx = {
      get: () => undefined,
      llm: {
        listProviders: () => providers,
        listConfigurableProviders: () => [],
        listModels: async () => models.map((id) => ({ id, name: id })),
      },
    }
    const projected = await new ExecutionModelResolver(
      ctx as never,
      {
        get: async () => catalog,
      } as never,
    ).resolve()
    for (const provider of providers)
      for (const model of models) {
        const ref = { provider: provider.id, model }
        const projectedModel = projected.models.find(
          (item) => JSON.stringify(item.ref) === JSON.stringify(ref),
        )
        if (
          ['our-free-model', 'our-free-model-region'].includes(provider.id) &&
          model === 'combo:my-route'
        )
          expect(projectedModel).toBeUndefined()
        else expect(projectedModel).toMatchObject({ ref, available: true, source: provider.name })
        const combinations = projected.combinations.filter(
          (item) => JSON.stringify(item.modelRef) === JSON.stringify(ref),
        )
        if (provider.id === 'our-free-model' && model === 'plugin-model')
          expect(combinations).toHaveLength(1)
        else expect(combinations).toEqual([])
      }
    expect(
      projected.combinations.find((item) => item.id === 'user-default')?.permissionPolicy,
    ).toBe('workspace')
  })

  it('excludes unconfigured providers and preserves explicit same-model channels', async () => {
    const { selectableModels } = await import('../../src/execution/contracts/catalog.ts')
    const model = (provider: string, id: string, available = true) => ({
      ref: { provider, model: id },
      name: id,
      source: provider,
      available,
    })
    const all = [
      model('deepseek-official', 'deepseek-flash', false),
      model('opl-gateway', 'codex::deepseek-flash'),
      model('opl-gateway', 'deepseek-flash'),
      model('opl-gateway', 'codex::gpt-current'),
      model('opl-gateway', 'grok::grok-4.7'),
    ]
    expect(selectableModels(all).map((m) => m.ref.model)).toEqual([
      'codex::deepseek-flash',
      'deepseek-flash',
      'codex::gpt-current',
      'grok::grok-4.7',
    ])
    expect(all).toHaveLength(5)
    expect(selectableModels([all[1]!])[0]?.ref.model).toBe('codex::deepseek-flash')
  })
  it('retains identical model names across independently configured providers', async () => {
    const { selectableModels } = await import('../../src/execution/contracts/catalog.ts')
    expect(
      selectableModels(
        ['official', 'custom'].map((provider) => ({
          ref: { provider, model: 'same' },
          name: 'Same',
          source: provider,
          available: true,
        })),
      ),
    ).toHaveLength(2)
  })
})
