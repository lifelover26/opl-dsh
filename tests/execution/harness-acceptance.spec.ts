import { describe, expect, it, vi } from 'vitest'
import { HarnessAcceptance } from '../../src/execution/host/harness-acceptance.ts'
import { codexAdapter } from '../../src/execution/host/adapters/codex.ts'
import type { HarnessAdapter } from '../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
function setup() {
  const request = vi.fn(async (method: string) =>
    method === 'initialize'
      ? { agentCapabilities: { loadSession: true } }
      : method === 'session/prompt'
        ? { stopReason: 'end_turn' }
        : { sessionId: 'native-one', models: { currentModelId: 'gpt-6' } },
  )
  const record = {
    cwd: '/owned',
    modelRef: { provider: 'opl-gateway', model: 'codex::gpt-6' },
  } as HarnessSession
  const runner = new HarnessAcceptance({ request }, codexAdapter, record, 'gpt-6')
  return { runner, request }
}
describe('shared Harness acceptance steps', () => {
  it.each(['new', 'load'])(
    'authenticates before %s and verifies the configured model',
    async (operation) => {
      const request = vi.fn(async (method: string) =>
        method === 'initialize'
          ? { agentCapabilities: { loadSession: true }, authMethods: [{ id: 'gemini-api-key' }] }
          : method === 'authenticate'
            ? {}
            : { sessionId: 'native-one', models: { currentModelId: 'vendor-default' } },
      )
      const adapter: HarnessAdapter = {
        ...codexAdapter,
        authenticate: async (acp) => {
          await acp.request('authenticate', { methodId: 'gemini-api-key' })
        },
        configureSession: async () => ({ modelId: 'gemini-4-argon', configOptions: [] }),
        verifySession: vi.fn(),
      }
      const runner = new HarnessAcceptance(
        { request },
        adapter,
        { cwd: '/owned' } as HarnessSession,
        'gemini-4-argon',
      )
      await expect(runner.open(operation === 'load' ? 'native-one' : undefined)).resolves.toBe(
        'native-one',
      )
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        'initialize',
        'authenticate',
        `session/${operation}`,
      ])
      expect(adapter.verifySession).toHaveBeenCalled()
    },
  )
  it('refuses a configuration that did not confirm the selected model', async () => {
    const { request } = setup()
    const adapter: HarnessAdapter = {
      ...codexAdapter,
      configureSession: async () => ({ modelId: 'other' }),
    }
    const runner = new HarnessAcceptance(
      { request },
      adapter,
      { cwd: '/owned' } as HarnessSession,
      'gpt-6',
    )
    await expect(runner.open()).rejects.toThrow('回读')
    await expect(runner.probe('probe', async () => true)).rejects.toThrow('未就绪')
    expect(request.mock.calls.some(([method]) => method === 'session/prompt')).toBe(false)
  })
  it('requires completed tools and independently checked artifacts, rather than assistant claims', async () => {
    const { runner, request } = setup()
    await runner.open()
    await expect(runner.probe('probe', async () => true)).rejects.toThrow('真实工具')
    request.mockImplementationOnce(async () => {
      runner.observe({
        sessionId: 'other',
        update: { sessionUpdate: 'tool_call', toolCallId: 'wrong', status: 'completed' },
      })
      runner.observe({
        sessionId: 'native-one',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tool-one', status: 'completed' },
      })
      return { stopReason: 'end_turn' } as never
    })
    expect(await runner.probe('probe', async () => true)).toMatchObject({
      completedTools: 1,
      artifactVerified: true,
    })
  })
  it('refuses resume identity or model drift before sending a prompt', async () => {
    const { runner, request } = setup()
    await expect(runner.open('other-id')).rejects.toThrow('回读')
    expect(request.mock.calls.some(([method]) => method === 'session/prompt')).toBe(false)
  })
  it('accepts the native identity on load and rejects a failed artifact check', async () => {
    const { runner, request } = setup()
    await runner.open('native-one')
    request.mockImplementationOnce(async () => {
      runner.observe({
        sessionId: 'native-one',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'one', status: 'completed' },
      })
      return { stopReason: 'end_turn' } as never
    })
    await expect(runner.probe('probe', async () => false)).rejects.toThrow('产物')
  })
  it('does not count cancellation acknowledgement as termination of the original turn', async () => {
    const { runner, request } = setup()
    await runner.open()
    let finish!: (value: { stopReason: string }) => void
    request.mockImplementation(async (method) => {
      if (method === 'session/prompt')
        return new Promise((done) => {
          finish = done
        }) as never
      finish({ stopReason: 'end_turn' })
      return {} as never
    })
    await expect(runner.cancelProbe('wait', Promise.resolve())).rejects.toThrow('未确认取消')
  })
})
