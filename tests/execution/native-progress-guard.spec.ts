import { describe, expect, it, vi } from 'vitest'
import {
  guardNativeProgress,
  nativeUsefulProgress,
} from '../../src/execution/host/native-progress-guard.js'

describe('native progress observation', () => {
  it('ignores empty text and metadata', () => {
    expect(nativeUsefulProgress({ type: 'text-delta', index: 0, text: '' })).toBe(false)
    expect(nativeUsefulProgress({ type: 'block-start', index: 0, blockType: 'text' })).toBe(false)
    expect(nativeUsefulProgress({ type: 'text-delta', index: 0, text: 'a' })).toBe(true)
  })

  it('starts when consumed and preserves output', async () => {
    const clock = { start: vi.fn(), progress: vi.fn() }
    const chunk = { type: 'reasoning-delta', index: 0, text: 'thinking' } as const
    const stream = guardNativeProgress(async function* () {
      yield chunk
    }, clock)
    expect(clock.start).not.toHaveBeenCalled()
    const received = []
    for await (const value of stream) received.push(value)
    expect(received).toEqual([chunk])
    expect(clock.start).toHaveBeenCalledOnce()
    expect(clock.progress).toHaveBeenCalledOnce()
  })
})

import { afterEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { installNativeProgressGuard } from '../../src/execution/host/native-progress-guard.js'

function fixture() {
  const controller = new AbortController()
  const cancel = vi.fn(() => controller.abort())
  let stream!: (
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>
  let stopping!: (payload: { signal: AbortSignal; agent: unknown; turn: number }) => void
  const listeners = new Map<string, (payload: never, next: () => Promise<never>) => unknown>()
  let dispose!: () => void
  // This test context implements only the public registrations owned by the guard.
  const ctx = {
    agents: { get: () => ({ cancel, session: { id: 'session' }, options: {} }) },
    on: (name: string, listener: unknown) => {
      if (name === 'llm/stream') stream = listener as typeof stream
      else {
        listeners.set(name, listener as (payload: never, next: () => Promise<never>) => unknown)
        if (name === 'agent/turn-stopping') stopping = listener as typeof stopping
      }
    },
    effect: (setup: () => () => void) => {
      dispose = setup()
    },
  } as unknown as Context
  installNativeProgressGuard(
    ctx,
    { enabled: true, firstProgressMs: 90, idleProgressMs: 90 },
    (options) => options.provider === 'native',
    true,
  )
  const options = {
    provider: 'native',
    model: 'test',
    messages: [],
    signal: controller.signal,
    sessionId: 'session',
  } as GenerateOptions
  const owner = { cancel, session: { id: 'session' }, options: {} }
  const consume = async () => {
    for await (const _ of stream(options, async function* () {
      yield { type: 'text-delta', index: 0, text: 'a' }
    })) {
      /* Consume the observed output. */
    }
  }
  return {
    owner,
    options,
    controller,
    cancel,
    consume,
    stopping: () => stopping({ signal: controller.signal, agent: owner, turn: 0 }),
    listeners,
    idle: () =>
      listeners.get('agent/status')?.(
        { agent: owner, status: 'idle' } as never,
        async () => undefined as never,
      ),
    dispose: () => dispose(),
  }
}

afterEach(() => vi.useRealTimers())

it('cancels the owning agent and propagates its signal on expiry', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.consume()
  await vi.advanceTimersByTimeAsync(90)
  expect(f.cancel).toHaveBeenCalledWith(
    { kind: 'hook', reason: '原生执行长时间没有新进展' },
    { keepInbox: true },
  )
  expect(f.controller.signal.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.cancel).toHaveBeenCalledOnce()
})

it.each(['stopping', 'dispose'] as const)('removes deadlines on %s', async (method) => {
  vi.useFakeTimers()
  const f = fixture()
  await f.consume()
  f[method]()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.cancel).not.toHaveBeenCalled()
})

it('allows useful progress across same-turn requests without a total deadline', async () => {
  vi.useFakeTimers()
  const f = fixture()
  for (let i = 0; i < 20; i++) {
    await f.consume()
    await vi.advanceTimersByTimeAsync(80)
  }
  expect(f.cancel).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10)
  expect(f.cancel).toHaveBeenCalledWith(
    { kind: 'hook', reason: '原生执行长时间没有新进展' },
    { keepInbox: true },
  )
})

it('releases a hung pull on abort and ignores late output and hung teardown', async () => {
  const controller = new AbortController()
  let finish!: (value: IteratorResult<StreamChunk>) => void
  const cleanup = vi.fn(() => new Promise<IteratorResult<StreamChunk>>(() => {}))
  const source: AsyncIterable<StreamChunk> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      return: cleanup,
    }),
  }
  const clock = { start: vi.fn(), progress: vi.fn() }
  const iterator = guardNativeProgress(() => source, clock, controller.signal)[
    Symbol.asyncIterator
  ]()
  const pending = iterator.next()
  const rejected = expect(pending).rejects.toThrow('Native execution cancelled')
  controller.abort()
  await rejected
  expect(cleanup).toHaveBeenCalledOnce()
  finish({ done: false, value: { type: 'text-delta', index: 0, text: 'late' } })
  await Promise.resolve()
  expect(clock.progress).not.toHaveBeenCalled()
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
})

it('observes rejection from a pull that settles after cancellation', async () => {
  const controller = new AbortController()
  let fail!: (reason: Error) => void
  const source: AsyncIterable<StreamChunk> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    }),
  }
  const iterator = guardNativeProgress(
    () => source,
    { start() {}, progress() {} },
    controller.signal,
  )[Symbol.asyncIterator]()
  const pending = iterator.next()
  const rejected = expect(pending).rejects.toThrow('Native execution cancelled')
  controller.abort()
  await rejected
  fail(new Error('late provider failure'))
  await Promise.resolve()
})

it.each(['approval/request', 'user-questions/request'])(
  'pauses overlapping %s waits',
  async (event) => {
    vi.useFakeTimers()
    const f = fixture()
    await f.consume()
    let one!: () => void
    let two!: () => void
    const listener = f.listeners.get(event)!
    const first = listener(
      { agent: f.owner } as never,
      () =>
        new Promise((resolve) => {
          one = () => resolve(undefined as never)
        }),
    )
    const second = listener(
      { agent: f.owner } as never,
      () =>
        new Promise((resolve) => {
          two = () => resolve(undefined as never)
        }),
    )
    await vi.advanceTimersByTimeAsync(1000)
    one()
    await first
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.cancel).not.toHaveBeenCalled()
    two()
    await second
    await vi.advanceTimersByTimeAsync(90)
    expect(f.cancel).toHaveBeenCalledOnce()
  },
)

it.each(['tools/pre-execute', 'tools/execute'])(
  'does not limit the duration of %s',
  async (event) => {
    vi.useFakeTimers()
    const f = fixture()
    await f.consume()
    let finish!: () => void
    const pending = f.listeners.get(event)!(
      { agent: f.owner } as never,
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined as never)
        }),
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(f.cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.cancel).not.toHaveBeenCalled()
    finish()
    await pending
    await vi.advanceTimersByTimeAsync(90)
    expect(f.cancel).toHaveBeenCalledOnce()
  },
)

it('preserves inactivity protection across child signals and renews after idle', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.consume()
  await vi.advanceTimersByTimeAsync(80)
  f.options.signal = new AbortController().signal
  await f.consume()
  await vi.advanceTimersByTimeAsync(90)
  expect(f.cancel).toHaveBeenCalledOnce()
  f.idle()
  f.options.signal = new AbortController().signal
  await f.consume()
  await vi.advanceTimersByTimeAsync(80)
  expect(f.cancel).toHaveBeenCalledOnce()
  f.dispose()
})

it.each(['approval/request', 'user-questions/request'] as const)(
  'wraps an earlier terminal %s handler in a real Cordis waterfall',
  async (event) => {
    vi.useFakeTimers()
    const { Context: RuntimeContext } = await import('@deepseek-ai/cordis')
    const ctx = new RuntimeContext()
    const controller = new AbortController()
    const cancel = vi.fn()
    const owner = { session: { id: 'session' }, cancel }
    Object.defineProperty(ctx, 'agents', { value: { get: () => owner } })
    let finish!: () => void
    ctx.on(
      event,
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined as never)
        }),
    )
    installNativeProgressGuard(
      ctx,
      { enabled: true, firstProgressMs: 90, idleProgressMs: 90 },
      () => true,
      true,
    )
    const options = {
      provider: 'native',
      model: 'test',
      messages: [],
      sessionId: 'session',
      signal: controller.signal,
    } as GenerateOptions
    const chunks = ctx.waterfall('llm/stream', options, async function* () {
      yield { type: 'text-delta', index: 0, text: 'hello' } as const
    })
    for await (const _chunk of chunks) {
      /* Consume the request before human wait. */
    }
    const pending = ctx.waterfall(event, { agent: owner } as never, async () => undefined as never)
    await vi.advanceTimersByTimeAsync(1000)
    expect(cancel).not.toHaveBeenCalled()
    finish()
    await pending
    await vi.advanceTimersByTimeAsync(90)
    expect(cancel).toHaveBeenCalledOnce()
  },
)

it('leaves the original stream untouched while OPL deadlines are disabled', () => {
  let listener!: (
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>
  const owner = { cancel: vi.fn(), session: { id: 'session' } }
  const ctx = {
    agents: { get: () => owner },
    on: (name: string, callback: unknown) => {
      if (name === 'llm/stream') listener = callback as typeof listener
    },
    effect: vi.fn(),
  } as unknown as Context
  installNativeProgressGuard(
    ctx,
    { enabled: false, firstProgressMs: 90, idleProgressMs: 90 },
    () => true,
  )
  const original = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'a' } as const
  })()
  expect(
    listener(
      { signal: new AbortController().signal, sessionId: 'session' } as GenerateOptions,
      () => original,
    ),
  ).toBe(original)
  expect(owner.cancel).not.toHaveBeenCalled()
})
