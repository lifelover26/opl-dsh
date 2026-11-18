import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { adapterFor, defaultHarness } from '../../src/execution/host/adapters/index.ts'
import { defaultExecutionCatalog, normalizeCatalog } from '../../src/execution/host/catalog.ts'
import { ExternalModelSources } from '../../src/execution/host/model-sources.ts'
import { harnessAllowsFullAccess } from '../../src/execution/host/permissions.ts'
import {
  applyOfmModelSource,
  createOfmApiConnection,
  OFM_PROVIDER,
  OFM_REGION_PROVIDER,
  OFM_PINNED_HARNESS_MODELS,
  ofmProtocol,
} from '../../src/execution/host/ofm-source/index.ts'

const pairings = Object.entries(OFM_PINNED_HARNESS_MODELS).map(([id, models]) => ({
  id: id === 'kimi' ? 'kimi-code' : id === 'mimo' ? 'mimo-code' : id,
  models,
}))

function fixture() {
  const models = pairings.flatMap((row) => row.models)
  const disposers: (() => void)[] = []
  const ctx = {
    effect: (effect: () => () => void) => {
      const dispose = effect()
      disposers.push(dispose)
      return dispose
    },
    llm: {
      listProviders: () => [{ id: OFM_PROVIDER }],
      listModels: async () => models.map((id) => ({ id })),
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
    },
  } as unknown as Context
  const sources = new ExternalModelSources(ctx)
  ctx.oplExternalModelSources = sources
  const calls: string[] = []
  const dispose = applyOfmModelSource(ctx, {
    providers: [OFM_PROVIDER],
    connection: createOfmApiConnection(async (request) => {
      calls.push(request.url)
      if (request.url === '/api/our-free-model/summary')
        return {
          status: 200,
          body: {
            settings: { enabled: true, forward: { enabled: true, running: true } },
            catalog: models.map((id) => ({ id, route: OFM_PROVIDER })),
          },
        }
      return {
        status: 200,
        body: { running: true, baseUrl: 'http://127.0.0.1:32123', key: 'dummy-ofm-key', models },
      }
    }, ''),
  })
  return { ctx, sources, models, calls, dispose }
}

describe('central OFM wiring', () => {
  for (const pairing of pairings.filter((pairing) => pairing.models.length > 0)) {
    it(`${pairing.id} binds every declared lane and refuses unrelated models`, async () => {
      const test = fixture()
      const catalog = defaultExecutionCatalog()
      if (pairing.id === 'muse-code') {
        expect(catalog.harnesses.some((h) => h.id === pairing.id)).toBe(false)
        catalog.harnesses.push({
          id: pairing.id,
          name: pairing.id,
          kind: 'acp',
          command: pairing.id,
        })
      } else expect(catalog.harnesses.some((h) => h.id === pairing.id)).toBe(true)
      expect(harnessAllowsFullAccess(pairing.id)).toBe(true)
      for (const model of pairing.models) {
        const ref = { provider: OFM_PROVIDER, model }
        const adapter = adapterFor(pairing.id, ref, test.sources)!
        expect(adapter).toBeDefined()
        expect(adapterFor(defaultHarness(ref), ref, test.sources)).toBeDefined()
        expect(adapter.capabilities.permissions).toContain('full-access')
        if (pairing.id !== 'codex')
          expect(adapter.capabilities.permissions).not.toContain('workspace')
        const route = await test.sources.resolve(pairing.id, ref, ofmProtocol(pairing.id)!)
        expect(route.model).toBe(model)
        expect(route.protocol).toBe(ofmProtocol(pairing.id))
      }
      expect(
        adapterFor(pairing.id, { provider: OFM_PROVIDER, model: 'unassigned-model' }, test.sources),
      ).toBeUndefined()
      const modelRef = { provider: OFM_PROVIDER, model: pairing.models[0]! }
      catalog.combinations.push({
        id: 'explicit-ofm',
        name: 'Explicit OFM',
        modelRef,
        harnessRef: pairing.id,
        permissionPolicy: 'full-access',
        enabled: true,
        isDefault: true,
      })
      expect(normalizeCatalog(catalog).combinations.at(-1)?.permissionPolicy).toBe('full-access')
      test.dispose()
      await expect(
        test.sources.resolve(pairing.id, modelRef, ofmProtocol(pairing.id)!),
      ).rejects.toThrow('尚未适配')
    })
  }

  it('refuses account-channel models before reading the anonymous connection', async () => {
    let calls = 0
    const connection = createOfmApiConnection(async () => {
      calls++
      throw Error('unexpected call')
    }, '')
    expect(
      await connection('zcode', { provider: OFM_REGION_PROVIDER, model: 'z-ai/glm-5.3' }, 'chat'),
    ).toBeUndefined()
    expect(calls).toBe(0)
  })

  it('supports the Muse source endpoint and reports a missing selected CLI', async () => {
    const test = fixture()
    const adapter = adapterFor(
      'muse-code',
      { provider: OFM_PROVIDER, model: 'muse-spark-1.3-contributor-free' },
      test.sources,
    )!
    expect(adapter.capabilities.customEndpoint).toBe(true)
    expect(
      await adapter.available(test.ctx, {
        home: '',
        grokCommand: '',
        nativeBridgePath: '',
        command: 'opl-owned-missing-muse-binary',
      }),
    ).toMatchObject({ available: false, reason: expect.stringContaining('Muse Code CLI') })
    test.dispose()
  })
})
