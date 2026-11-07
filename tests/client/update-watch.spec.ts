/** Logical update-stream failures recover without requiring a carrier reconnect. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OplUpdateStatus } from '../../src/updates/contracts.ts'
import { subscribeUpdateWatch, type UpdateWatchStream } from '../../src/updates/client/watch.ts'
import {
  UpdateController as HostUpdateController,
  type UpdateOperations,
} from '../../src/updates/host/controller.ts'
import { UpdateService } from '../../src/updates/host/index.ts'

const stops: (() => void)[] = []
const streams: ReturnType<typeof controlledStream>[] = []
const hosts: HostUpdateController[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  try {
    for (const stop of stops.splice(0).reverse()) stop()
    for (const stream of streams.splice(0)) stream.end()
    for (const host of hosts.splice(0)) await host.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

function status(): OplUpdateStatus {
  return {
    installedVersion: '0.2.55',
    officialVersion: '0.2.2-rc.1',
    localCandidate: false,
    automatic: true,
    checking: false,
    preparing: false,
    checkedAt: null,
    lastSuccessAt: null,
    error: null,
    release: null,
    pendingVersion: null,
  }
}

type Packet = { kind: 'item'; value: OplUpdateStatus } | { kind: 'end' } | { kind: 'error' }
function controlledStream(ignoreDispose = false) {
  const queue: Packet[] = []
  const waiters: {
    resolve(value: IteratorResult<OplUpdateStatus>): void
    reject(reason: Error): void
  }[] = []
  let terminal = false
  const deliver = (packet: Packet, waiter: (typeof waiters)[number]) => {
    switch (packet.kind) {
      case 'item':
        waiter.resolve({ done: false, value: packet.value })
        break
      case 'end':
        waiter.resolve({ done: true, value: undefined })
        break
      case 'error':
        waiter.reject(new Error('logical watch failure'))
        break
    }
  }
  const send = (packet: Packet) => {
    if (terminal) return
    if (packet.kind !== 'item') terminal = true
    const waiter = waiters.shift()
    if (waiter) deliver(packet, waiter)
    else queue.push(packet)
  }
  const end = () => {
    send({ kind: 'end' })
    for (const waiter of waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }
  const iterator: AsyncIterator<OplUpdateStatus> = {
    next: () =>
      new Promise((resolve, reject) => {
        const waiter = { resolve, reject }
        const packet = queue.shift()
        if (packet) deliver(packet, waiter)
        else if (terminal) resolve({ done: true, value: undefined })
        else waiters.push(waiter)
      }),
    return: async () => {
      end()
      return { done: true, value: undefined }
    },
  }
  const dispose = vi.fn(() => {
    if (!ignoreDispose) end()
  })
  const stream: UpdateWatchStream = { [Symbol.asyncIterator]: () => iterator, dispose }
  const result = {
    stream,
    dispose,
    end,
    item: () => send({ kind: 'item', value: status() }),
    fail: () => send({ kind: 'error' }),
  }
  streams.push(result)
  return result
}

function connection(initial: number | undefined = 1) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish(next: number | undefined) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    listeners,
  }
}

function subscribe(
  factory: () => UpdateWatchStream,
  listener = vi.fn(),
  source?: ReturnType<typeof connection>,
) {
  const stop = subscribeUpdateWatch(factory, listener, source)
  stops.push(stop)
  return { stop, listener }
}

describe('update watch recovery', () => {
  it('reopens the real Host watch after a transient initialization failure and observes later checks', async () => {
    const offer = {
      version: '0.3.0',
      officialVersion: '0.2.2-rc.1',
      url: 'https://github.com/gaofeng21cn/opl-dsh/releases/tag/opl-dsh-v0.3.0',
      publishedAt: '2026-11-07T00:00:00Z',
      compatibility: 'enhancement' as const,
    }
    const discover = vi.fn<UpdateOperations['discover']>(async () => offer)
    const host = new HostUpdateController({
      installed: async () => ({ suiteVersion: '0.2.55', officialVersion: '0.2.2-rc.1' }),
      automatic: () => false,
      saveAutomatic: async () => {},
      load: vi
        .fn()
        .mockRejectedValueOnce(new Error('cache temporarily locked'))
        .mockResolvedValue(null),
      save: async () => {},
      discover,
      pending: async () => null,
      prepare: async () => {},
      cancel: async () => {},
    })
    hosts.push(host)
    const shutdown = new AbortController()
    const handles: { dispose: ReturnType<typeof vi.fn> }[] = []
    const factory = vi.fn(() => {
      const invocation = new AbortController()
      // Exercise the endpoint with injected controller and invocation lifetime;
      // constructing its production service would read an actual installation.
      const receiver = {
        controller: host,
        shutdown,
        ctx: { invocation: { signal: invocation.signal } },
      }
      const iterator = UpdateService.prototype.watch.call(receiver as unknown as UpdateService)
      const handle = {
        [Symbol.asyncIterator]: () => iterator[Symbol.asyncIterator](),
        dispose: vi.fn(() => invocation.abort()),
      }
      handles.push(handle)
      return handle
    })
    const f = subscribe(factory)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listener).toHaveBeenCalledTimes(1)
    expect((await host.status()).installedVersion).toBe('0.2.55')
    await host.check()
    expect(f.listener).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(f.listener).toHaveBeenCalledTimes(2)
    discover.mockResolvedValue(null)
    const observed = f.listener.mock.calls.length
    await host.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listener.mock.calls.length).toBeGreaterThan(observed)
    f.stop()
    expect(handles.every((handle) => handle.dispose.mock.calls.length === 1)).toBe(true)
    shutdown.abort()
  })

  it('opens one stream and notifies on real status items without scheduling checks or retries', async () => {
    const active = controlledStream()
    const factory = vi.fn(() => active.stream)
    const f = subscribe(factory)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(f.listener).not.toHaveBeenCalled()
    active.item()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listener).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    f.stop()
    expect(active.dispose).toHaveBeenCalledTimes(1)
  })

  it('notifies a status reread after unexpected normal completion and reopens after one second', async () => {
    const first = controlledStream()
    const second = controlledStream()
    const factory = vi.fn().mockReturnValueOnce(first.stream).mockReturnValue(second.stream)
    const f = subscribe(factory)
    first.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listener).toHaveBeenCalledTimes(1)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(factory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(2)
    second.item()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listener).toHaveBeenCalledTimes(2)
  })

  it('backs off logical failures at one, three, ten, then capped thirty seconds', async () => {
    const opened: ReturnType<typeof controlledStream>[] = []
    const factory = vi.fn(() => {
      const stream = controlledStream()
      opened.push(stream)
      return stream.stream
    })
    const f = subscribe(factory)
    const delays = [1000, 3000, 10_000, 30_000, 30_000]
    for (const [index, delay] of delays.entries()) {
      opened.at(-1)!.fail()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.listener).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(factory).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(factory).toHaveBeenCalledTimes(index + 2)
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers from a synchronous stream-open failure with the same backoff', async () => {
    const active = controlledStream()
    let failures = 3
    const factory = vi.fn(() => {
      if (failures-- > 0) throw new Error('endpoint temporarily unavailable')
      return active.stream
    })
    const f = subscribe(factory)
    expect(f.listener).toHaveBeenCalledTimes(1)
    for (const delay of [1000, 3000, 10_000]) await vi.advanceTimersByTimeAsync(delay)
    expect(factory).toHaveBeenCalledTimes(4)
    expect(f.listener).toHaveBeenCalledTimes(3)
    active.item()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listener).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resets backoff only after a real status item arrives', async () => {
    const opened: ReturnType<typeof controlledStream>[] = []
    const factory = vi.fn(() => {
      const stream = controlledStream()
      opened.push(stream)
      return stream.stream
    })
    subscribe(factory)
    opened[0]!.fail()
    await vi.advanceTimersByTimeAsync(1000)
    opened[1]!.fail()
    await vi.advanceTimersByTimeAsync(3000)
    expect(factory).toHaveBeenCalledTimes(3)
    opened[2]!.item()
    await vi.advanceTimersByTimeAsync(0)
    opened[2]!.fail()
    await vi.advanceTimersByTimeAsync(999)
    expect(factory).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(4)
  })

  it('continues observing when the consumer callback throws', async () => {
    const active = controlledStream()
    const listener = vi.fn(() => {
      throw new Error('consumer callback failed')
    })
    subscribe(() => active.stream, listener)
    active.item()
    await vi.advanceTimersByTimeAsync(0)
    active.item()
    await vi.advanceTimersByTimeAsync(0)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(active.dispose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('update watch generation and cleanup', () => {
  it('waits for readiness, replaces the old generation, and ignores unchanged notifications', async () => {
    const source = connection()
    source.publish(undefined)
    const first = controlledStream()
    const second = controlledStream()
    const factory = vi.fn().mockReturnValueOnce(first.stream).mockReturnValue(second.stream)
    const f = subscribe(factory, vi.fn(), source)
    expect(factory).not.toHaveBeenCalled()
    expect(source.listeners.size).toBe(1)
    source.publish(1)
    expect(factory).toHaveBeenCalledTimes(1)
    source.publish(1)
    expect(factory).toHaveBeenCalledTimes(1)
    source.publish(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(f.listener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    source.publish(2)
    expect(factory).toHaveBeenCalledTimes(2)
    f.stop()
    expect(second.dispose).toHaveBeenCalledTimes(1)
    expect(source.listeners.size).toBe(0)
  })

  it.each(['item', 'error', 'end'] as const)(
    'ignores a late old-generation %s without retrying it',
    async (outcome) => {
      const source = connection()
      const first = controlledStream(true)
      const second = controlledStream()
      const factory = vi.fn().mockReturnValueOnce(first.stream).mockReturnValue(second.stream)
      const f = subscribe(factory, vi.fn(), source)
      source.publish(2)
      if (outcome === 'item') first.item()
      else if (outcome === 'error') first.fail()
      else first.end()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.listener).not.toHaveBeenCalled()
      expect(factory).toHaveBeenCalledTimes(2)
      expect(first.dispose).toHaveBeenCalledTimes(1)
      expect(second.dispose).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      second.item()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.listener).toHaveBeenCalledTimes(1)
    },
  )

  it('cancels a pending retry on connection loss and restarts backoff for the new generation', async () => {
    const source = connection()
    const first = controlledStream()
    const second = controlledStream()
    const third = controlledStream()
    const factory = vi
      .fn()
      .mockReturnValueOnce(first.stream)
      .mockReturnValueOnce(second.stream)
      .mockReturnValue(third.stream)
    subscribe(factory, vi.fn(), source)
    first.fail()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    source.publish(undefined)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    source.publish(2)
    second.fail()
    await vi.advanceTimersByTimeAsync(999)
    expect(factory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(3)
  })

  it('disposes an active stream once and ignores its late rejection after unmount', async () => {
    const source = connection()
    const active = controlledStream(true)
    const factory = vi.fn(() => active.stream)
    const f = subscribe(factory, vi.fn(), source)
    f.stop()
    f.stop()
    active.fail()
    source.publish(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(active.dispose).toHaveBeenCalledTimes(1)
    expect(f.listener).not.toHaveBeenCalled()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(source.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a scheduled retry on unmount', async () => {
    const active = controlledStream()
    const factory = vi.fn(() => active.stream)
    const f = subscribe(factory)
    active.fail()
    await vi.advanceTimersByTimeAsync(0)
    f.stop()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(active.dispose).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule a retry when the termination callback unmounts the consumer', async () => {
    const active = controlledStream()
    const factory = vi.fn(() => active.stream)
    let stop!: () => void
    const listener = vi.fn(() => stop())
    stop = subscribe(factory, listener).stop
    active.end()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not arm an old-generation retry when a failure callback changes generation', async () => {
    const source = connection()
    const first = controlledStream()
    const second = controlledStream()
    const factory = vi.fn().mockReturnValueOnce(first.stream).mockReturnValue(second.stream)
    const listener = vi.fn(() => source.publish(2))
    subscribe(factory, listener, source)
    first.fail()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposes a stream whose factory synchronously replaced its generation', async () => {
    const source = connection()
    const first = controlledStream()
    const second = controlledStream()
    const factory = vi
      .fn<() => UpdateWatchStream>()
      .mockImplementationOnce(() => {
        source.publish(2)
        return first.stream
      })
      .mockReturnValue(second.stream)
    const f = subscribe(factory, vi.fn(), source)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    second.item()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listener).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still replaces a stream when its carrier disposer throws', async () => {
    const source = connection()
    const first = controlledStream()
    const second = controlledStream()
    first.dispose.mockImplementation(() => {
      first.end()
      throw new Error('carrier cancellation failed')
    })
    const factory = vi.fn().mockReturnValueOnce(first.stream).mockReturnValue(second.stream)
    const f = subscribe(factory, vi.fn(), source)
    expect(() => source.publish(2)).not.toThrow()
    expect(first.dispose).toHaveBeenCalledTimes(1)
    second.item()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listener).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
