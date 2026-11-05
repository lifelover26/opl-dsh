import { describe, expect, it, vi } from 'vitest'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import type {
  ExternalEditContext,
  ExternalEditHistory,
} from '../../src/execution/host/message-edit-driver.ts'
import { stepMessageEditDriver } from '../../src/execution/host/message-edit-step.ts'

const capability = {
  'opl/message-edit': {
    version: 1,
    methods: ['opl/edit/read', 'opl/edit/rewind'],
    ephemeralFirstFork: true,
  },
}
const history: ExternalEditHistory = {
  sessionId: 'step-old',
  token: 'sha256:source',
  boundaries: [
    { id: 'u1', text: 'same text' },
    { id: 'u2', text: 'same text' },
  ],
}

function setup(reply: unknown = { ok: true, ...history }) {
  const controller = new AbortController()
  const request = vi.fn(
    async (_method: string, _params: unknown, _timeout?: number): Promise<unknown> => reply,
  )
  const record = {
    id: 'record-1',
    nativeSessionId: 'fixed-dsh-id',
    acpSessionId: 'step-old',
    harnessRef: 'step-code',
    turns: [{ prompt: 'same text' }, { prompt: 'same text' }],
  } as HarnessSession
  const disconnect = vi.fn(async () => {})
  const reconnect = vi.fn(async () => {})
  const context: ExternalEditContext = {
    record,
    launch: { home: '', command: '', args: [], env: {} },
    signal: controller.signal,
    snapshot: () => ({
      agent: { agentCapabilities: { _meta: capability } },
      session: {},
      configOptions: [],
    }),
    transport: () => ({ request }),
    disconnect,
    reconnect,
  }
  return {
    context,
    request,
    controller,
    record,
    disconnect,
    reconnect,
    driver: stepMessageEditDriver(),
  }
}

const input = { operationId: 'edit-operation', targetId: 'u2', expected: history }

describe('StepCode message-edit driver', () => {
  it('uses distinct native ids for identical text and only the advertised read RPC', async () => {
    const run = setup({ ok: true, ...history, settledInputId: 'u2' })
    expect(await run.driver.read(run.context)).toEqual({ ...history, settledInputId: 'u2' })
    expect(run.request).toHaveBeenCalledExactlyOnceWith(
      'opl/edit/read',
      { sessionId: 'step-old' },
      20_000,
    )
  })

  function failedRun() {
    const run = setup()
    run.record.turns = [
      { state: 'completed', native: { userMessageId: 'u1' } },
      { state: 'failed', native: { userMessageId: 'u2' } },
    ] as HarnessSession['turns']
    return run
  }

  it('waits for owned exit and stable idle readback before settling a failed input with no assistant', async () => {
    const run = failedRun()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    run.disconnect.mockImplementation(async () => {
      entered.resolve()
      await release.promise
    })
    let done = false
    const result = run.driver.read(run.context).then((value) => {
      done = true
      return value
    })
    await entered.promise
    expect(done).toBe(false)
    expect(run.request).toHaveBeenCalledTimes(1)
    expect(run.reconnect).not.toHaveBeenCalled()
    release.resolve()
    expect(await result).toEqual({ ...history, settledInputId: 'u2' })
    expect(run.disconnect).toHaveBeenCalledTimes(1)
    expect(run.reconnect).toHaveBeenCalledExactlyOnceWith('step-old')
    expect(run.request.mock.calls.map((call) => call[0])).toEqual([
      'opl/edit/read',
      'opl/edit/read',
      'opl/edit/read',
    ])
  })

  it.each(['missing-input', 'wrong-input', 'missing-prefix', 'wrong-prefix', 'running'])(
    'does not infer settlement from a failed record with %s',
    async (reason) => {
      const run = failedRun()
      if (reason === 'missing-input') delete run.record.turns[1]!.native!.userMessageId
      if (reason === 'wrong-input') run.record.turns[1]!.native!.userMessageId = 'other'
      if (reason === 'missing-prefix') delete run.record.turns[0]!.native!.userMessageId
      if (reason === 'wrong-prefix') run.record.turns[0]!.native!.userMessageId = 'other'
      if (reason === 'running') run.record.turns[1]!.state = 'running'
      expect(await run.driver.read(run.context)).toEqual(history)
      expect(run.disconnect).not.toHaveBeenCalled()
      expect(run.reconnect).not.toHaveBeenCalled()
    },
  )

  it.each(['after-exit', 'second-read'])('refuses history changes at %s', async (when) => {
    const run = failedRun()
    run.request
      .mockResolvedValueOnce({ ok: true, ...history })
      .mockResolvedValueOnce({
        ok: true,
        ...history,
        token: when === 'after-exit' ? 'changed' : history.token,
      })
      .mockResolvedValueOnce({ ok: true, ...history, token: 'changed' })
    await expect(run.driver.read(run.context)).rejects.toMatchObject({ code: 'history-changed' })
    expect(run.request).toHaveBeenCalledTimes(3)
  })

  it('retains busy refusal without stopping an active official prompt', async () => {
    const run = failedRun()
    run.request.mockResolvedValue({ ok: false, code: 'busy' })
    await expect(run.driver.read(run.context)).rejects.toMatchObject({ code: 'busy' })
    expect(run.disconnect).not.toHaveBeenCalled()
    expect(run.reconnect).not.toHaveBeenCalled()
  })

  it('retains the send guard when owned cleanup fails', async () => {
    const run = failedRun()
    run.disconnect.mockRejectedValue(Error('private transport detail'))
    await expect(run.driver.read(run.context)).rejects.toMatchObject({
      code: 'control-unavailable',
    })
    expect(run.reconnect).not.toHaveBeenCalled()
    expect(run.request).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect after cancellation during owned cleanup', async () => {
    const run = failedRun()
    run.disconnect.mockImplementation(async () => run.controller.abort())
    await expect(run.driver.read(run.context)).rejects.toMatchObject({ code: 'aborted' })
    expect(run.reconnect).not.toHaveBeenCalled()
  })

  it('returns verified retained ids without writing the record, reconnecting, or sending a prompt', async () => {
    const run = setup({
      ok: true,
      sessionId: 'step-new',
      retained: [{ previousId: 'u1', nextId: 'u1' }],
    })
    const before = structuredClone(run.record)
    expect(await run.driver.rewind(run.context, input)).toEqual({
      sessionId: 'step-new',
      retained: [{ previousId: 'u1', nextId: 'u1' }],
    })
    expect(run.request).toHaveBeenCalledExactlyOnceWith(
      'opl/edit/rewind',
      {
        sessionId: 'step-old',
        operationId: 'edit-operation',
        targetId: 'u2',
        expectedToken: 'sha256:source',
      },
      60_000,
    )
    expect(run.record).toEqual(before)
    expect(run.disconnect).not.toHaveBeenCalled()
    expect(run.reconnect).not.toHaveBeenCalled()
  })

  it('reports an empty first-message fork as ephemeral', async () => {
    const run = setup({ ok: true, sessionId: 'lazy-new', retained: [], ephemeral: true })
    expect(await run.driver.rewind(run.context, { ...input, targetId: 'u1' })).toEqual({
      sessionId: 'lazy-new',
      retained: [],
      ephemeral: true,
    })
  })

  it.each([
    { agent: {} },
    { agent: { agentCapabilities: { _meta: {} } } },
    {
      agent: {
        agentCapabilities: {
          _meta: { 'opl/message-edit': { version: 1, methods: ['opl/edit/read'] } },
        },
      },
    },
  ])('refuses a missing or incomplete bridge capability before transport', async (snapshot) => {
    const run = setup()
    run.context.snapshot = () => ({ ...snapshot, session: {}, configOptions: [] })
    await expect(run.driver.read(run.context)).rejects.toMatchObject({ code: 'unsupported' })
    expect(run.request).not.toHaveBeenCalled()
  })

  it.each([
    { ...history, boundaries: [{ id: 'u1' }, { id: 'u1' }] },
    { ...history, boundaries: [{ id: 'u1', text: 7 }] },
    { ...history, boundaries: [{ id: '' }] },
    { ...history, settledInputId: 'u1' },
    { ...history, token: '' },
  ])('rejects an unverifiable history reply', async (invalid) => {
    const run = setup({ ok: true, ...invalid })
    await expect(run.driver.read(run.context)).rejects.toMatchObject({ code: 'protocol' })
  })

  it('rejects a changed session identity', async () => {
    const run = setup({ ok: true, ...history, sessionId: 'other-step' })
    await expect(run.driver.read(run.context)).rejects.toMatchObject({ code: 'stale' })
  })

  it.each(['busy', 'history-changed', 'fork-rejected', 'uncertain'])(
    'retains the bridge refusal code %s',
    async (code) => {
      const run = setup({ ok: false, code, error: 'provider text must not be echoed' })
      await expect(run.driver.rewind(run.context, input)).rejects.toMatchObject({ code })
      expect(run.request).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { sessionId: 'step-old', retained: [{ previousId: 'u1', nextId: 'u1' }] },
    { sessionId: 'new', retained: [] },
    { sessionId: 'new', retained: [{ previousId: 'u1', nextId: 'remapped-id' }] },
    { sessionId: 'new', retained: [{ previousId: 'u2', nextId: 'u2' }] },
    { sessionId: 'new', retained: [{ previousId: 'u1', nextId: 'u1' }], ephemeral: true },
    { sessionId: 'new', retained: [{ previousId: 'u1', nextId: 'u1' }], ephemeral: 'yes' },
  ])('treats malformed mutation results as uncertain', async (invalid) => {
    const run = setup({ ok: true, ...invalid })
    await expect(run.driver.rewind(run.context, input)).rejects.toMatchObject({ code: 'uncertain' })
  })

  it('does not reinterpret an unstructured failure as proof the fork was rejected', async () => {
    const run = setup({ success: false, error: 'unknown official reply' })
    await expect(run.driver.rewind(run.context, input)).rejects.toMatchObject({ code: 'uncertain' })
  })

  it('refuses an unknown or unavailable target without invoking the bridge', async () => {
    const run = setup()
    await expect(
      run.driver.rewind(run.context, { ...input, targetId: 'missing' }),
    ).rejects.toMatchObject({ code: 'target-unknown' })
    await expect(
      run.driver.rewind(run.context, {
        ...input,
        expected: {
          ...history,
          boundaries: [{ id: 'u1' }, { id: 'u2', unavailableReason: 'attachment' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'target-unavailable' })
    expect(run.request).not.toHaveBeenCalled()
  })

  it('refuses cancellation before the mutation request', async () => {
    const run = setup()
    run.controller.abort()
    await expect(run.driver.rewind(run.context, input)).rejects.toMatchObject({ code: 'aborted' })
    expect(run.request).not.toHaveBeenCalled()
  })

  it('treats cancellation after dispatch as uncertain and never retries', async () => {
    const run = setup()
    run.request.mockImplementation(async () => {
      run.controller.abort()
      throw Error('wire credential-like text')
    })
    await expect(run.driver.rewind(run.context, input)).rejects.toMatchObject({ code: 'uncertain' })
    expect(run.request).toHaveBeenCalledTimes(1)
  })

  it('keeps read transport failure credential-free', async () => {
    const run = setup()
    run.request.mockRejectedValue(Error('sensitive provider text'))
    await expect(run.driver.read(run.context)).rejects.toMatchObject({
      code: 'control-unavailable',
    })
    await expect(run.driver.read(run.context)).rejects.not.toThrow('sensitive provider text')
  })
})
