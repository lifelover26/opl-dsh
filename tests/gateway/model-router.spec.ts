import { describe, expect, it, vi } from 'vitest'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GatewayModelAdapter } from '../../src/gateway/host/model-router.ts'
const request: GenerateOptions = {
  provider: 'opl-gateway',
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}
class Adapter extends LlmAdapter {
  constructor(
    readonly run: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
    readonly models: string[],
  ) {
    super()
  }
  override async listModels(provider: string) {
    return this.models.map((id) => ({ provider, id, name: id }))
  }
  stream(options: GenerateOptions) {
    return this.run(options)
  }
}
async function collect(adapter: LlmAdapter, options = request) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}
function setup() {
  const deepseek = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const codex = vi.fn(async function* (_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const adapter = new GatewayModelAdapter(
    [
      {
        group: 'deepseek',
        provider: 'opl-gateway',
        adapter: new Adapter(deepseek, ['deepseek-flash']),
        available: async () => true,
      },
      {
        group: 'codex',
        provider: 'opl-gateway-openai',
        adapter: new Adapter(codex, ['deepseek-flash', 'gpt-6-sol']),
        available: async () => true,
      },
    ],
    vi.fn(),
  )
  return { adapter, deepseek, codex }
}
describe('explicit group routing', () => {
  it('keeps two same-named models independently selectable', async () => {
    const { adapter, deepseek, codex } = setup()
    expect((await adapter.listModels('opl-gateway')).map((m) => m.id)).toEqual([
      'deepseek-flash',
      'codex::deepseek-flash',
      'codex::gpt-6-sol',
    ])
    await collect(adapter, { ...request, model: 'codex::deepseek-flash' })
    expect(deepseek).not.toHaveBeenCalled()
    expect(codex.mock.calls[0]?.[0]).toMatchObject({
      provider: 'opl-gateway-openai',
      model: 'deepseek-flash',
    })
  })
  it('uses Codex as the GPT primary route', async () => {
    const { adapter, codex } = setup()
    await collect(adapter, { ...request, model: 'codex::gpt-6-sol' })
    expect(codex).toHaveBeenCalledOnce()
  })
  it('publishes high as the Flash default for both protocol channels', async () => {
    const { adapter } = setup()
    vi.spyOn(Adapter.prototype, 'listModels').mockImplementation(async function (provider) {
      return this.models.map((id) => ({
        provider,
        id,
        name: id,
        reasoning: {
          defaultEffort: ReasoningEffortId('max'),
          efforts: ['low', 'high', 'max'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
        },
      }))
    })
    vi.spyOn(Adapter.prototype, 'resolveModel').mockImplementation(async (provider, id) => ({
      provider,
      id,
      name: id,
      reasoning: {
        defaultEffort: ReasoningEffortId('max'),
        efforts: ['low', 'high', 'max'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
      },
    }))
    const listed = await adapter.listModels('opl-gateway')
    for (const id of ['deepseek-flash', 'codex::deepseek-flash']) {
      expect(listed.find((m) => m.id === id)?.reasoning?.defaultEffort).toBe('high')
      expect((await adapter.resolveModel('opl-gateway', id)).reasoning?.defaultEffort).toBe('high')
    }
    vi.restoreAllMocks()
  })
  it('exposes native Harness reasoning choices through the DSH model catalog', async () => {
    const { adapter } = setup()
    const model = await adapter.resolveModel('opl-gateway', 'codex::gpt-6-sol')
    expect(model.reasoning?.efforts.map((item) => item.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    const listed = (await adapter.listModels('opl-gateway')).find(
      (item) => item.id === 'codex::gpt-6-sol',
    )
    expect(listed?.reasoning?.efforts.map((item) => item.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(model.reasoning?.defaultEffort).toBe('medium')
  })
  it.each([
    ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['gpt-6-luna', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['claude-fable-5-2', ['low', 'medium', 'high', 'xhigh', 'max'], 'high'],
    ['grok-4.7', ['low', 'medium', 'high', 'xhigh'], 'high'],
  ] as const)('uses the official Harness efforts for %s', async (id, efforts, defaultEffort) => {
    const adapter = new GatewayModelAdapter(
      [
        {
          group: 'codex',
          provider: 'source',
          available: async () => true,
          adapter: new Adapter(
            async function* () {
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
            [id],
          ),
        },
      ],
      vi.fn(),
    )
    const prepared = await adapter.prepareCall('opl-gateway', 'codex::' + id)
    expect(prepared.model.reasoning).toEqual({
      efforts: efforts.map((id) => ({ id, name: id })),
      defaultEffort,
    })
    expect(prepared.model.reasoning?.efforts.some((e) => ['default', 'ultra'].includes(e.id))).toBe(
      false,
    )
  })
  it('keeps unknown models under their own adapter capability', async () => {
    const adapter = new GatewayModelAdapter(
      [
        {
          group: 'codex',
          provider: 'source',
          available: async () => true,
          adapter: new Adapter(async function* () {}, ['future-model']),
        },
      ],
      vi.fn(),
    )
    expect(
      (await adapter.resolveModel('opl-gateway', 'codex::future-model')).reasoning,
    ).toBeUndefined()
  })
  it('does not send an unknown model to an arbitrary group', async () => {
    const { adapter, codex } = setup()
    await expect(collect(adapter, { ...request, model: 'unknown' })).rejects.toMatchObject({
      code: 'UNKNOWN_MODEL',
    })
    expect(codex).not.toHaveBeenCalled()
  })
  it('does not retry failures in another group', async () => {
    const { adapter, deepseek, codex } = setup()
    deepseek.mockImplementation(async function* () {
      throw new LlmError('down', 'SERVER')
    })
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'SERVER' })
    expect(codex).not.toHaveBeenCalled()
  })
  it('filters missing credentials and refuses direct dispatch', async () => {
    const adapter = new GatewayModelAdapter(
      [
        {
          group: 'deepseek',
          provider: 'opl-gateway',
          adapter: new Adapter(
            async function* () {
              throw Error('must not call')
            },
            ['deepseek-flash'],
          ),
          available: async () => false,
        },
      ],
      vi.fn(),
    )
    expect(await adapter.listModels('opl-gateway')).toEqual([])
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})

describe('dedicated reviewer routing', () => {
  it('keeps the reviewer independent from a user-owned chat model list', async () => {
    const run = vi.fn(async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const ordinary = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const adapter = new GatewayModelAdapter(
      [
        {
          group: 'codex',
          provider: 'chat',
          adapter: new Adapter(ordinary, ['gpt-6-sol']),
          available: async () => true,
        },
      ],
      () => {},
      {
        group: 'codex',
        provider: 'opl-gateway-auto-review',
        adapter: new Adapter(run, ['codex-auto-review']),
        available: async () => true,
      },
    )
    expect((await adapter.listModels('opl-gateway')).map((model) => model.id)).toEqual([
      'codex::gpt-6-sol',
      'codex::codex-auto-review',
    ])
    await collect(adapter, { ...request, model: 'codex::codex-auto-review' })
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      provider: 'opl-gateway-auto-review',
      model: 'codex-auto-review',
    })
    expect(ordinary).not.toHaveBeenCalled()
  })
  it('does not borrow a chat route when the dedicated provider is unavailable', async () => {
    const run = async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const adapter = new GatewayModelAdapter(
      [
        {
          group: 'codex',
          provider: 'chat',
          adapter: new Adapter(run, ['codex-auto-review']),
          available: async () => true,
        },
      ],
      () => {},
      {
        group: 'codex',
        provider: 'dedicated',
        adapter: new Adapter(run, ['codex-auto-review']),
        available: async () => false,
      },
    )
    expect(await adapter.listModels('opl-gateway')).toEqual([])
    await expect(
      collect(adapter, { ...request, model: 'codex::codex-auto-review' }),
    ).rejects.toThrow('凭据未就绪')
  })
})
