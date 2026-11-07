import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateController, type UpdateOperations } from '../../src/updates/host/controller.ts'
import type { OplUpdateRelease } from '../../src/updates/contracts.ts'

const offer: OplUpdateRelease = {
  version: '0.3.0',
  officialVersion: '0.2.2-rc.1',
  url: 'https://github.com/gaofeng21cn/opl-dsh/releases/tag/opl-dsh-v0.3.0',
  publishedAt: '2026-11-07T00:00:00Z',
  compatibility: 'enhancement',
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  let automatic = true
  let pending: string | null = null
  const operations: UpdateOperations = {
    installed: vi.fn(async () => ({
      suiteVersion: '0.2.55',
      officialVersion: '0.2.2-rc.1',
      localCandidate: true,
    })),
    automatic: () => automatic,
    saveAutomatic: vi.fn(async (enabled) => {
      automatic = enabled
    }),
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    discover: vi.fn(async () => offer),
    pending: vi.fn(async () => pending),
    prepare: vi.fn(async (_signal, expected) => {
      pending = expected
    }),
    cancel: vi.fn(async () => {
      pending = null
    }),
  }
  const controller = new UpdateController(operations)
  return { operations, controller }
}
afterEach(() => {
  vi.useRealTimers()
})

describe('Host update discovery and preparation', () => {
  it('reads status locally and coalesces concurrent checks without preparing an update', async () => {
    const f = fixture()
    expect((await f.controller.status()).localCandidate).toBe(true)
    expect(f.operations.discover).not.toHaveBeenCalled()
    const response = deferred<OplUpdateRelease | null>()
    vi.mocked(f.operations.discover).mockReturnValue(response.promise)
    const a = f.controller.check()
    const b = f.controller.check()
    await vi.waitFor(() => expect(f.operations.discover).toHaveBeenCalledTimes(1))
    expect((await f.controller.status()).checking).toBe(true)
    response.resolve(offer)
    expect((await a).release).toEqual(offer)
    expect((await b).release).toEqual(offer)
    expect(f.operations.prepare).not.toHaveBeenCalled()
    await f.controller.dispose()
  })

  it('retains the last verified offer on offline checks and reopens it from disk', async () => {
    const f = fixture()
    await f.controller.check()
    vi.mocked(f.operations.discover).mockRejectedValue(Error('private network diagnostic'))
    const result = await f.controller.check()
    expect(result.release).toEqual(offer)
    expect(result.error).toBe('check-failed')
    expect(result.lastSuccessAt).not.toBeNull()
    expect(JSON.stringify(result)).not.toContain('private')
    const reopened = fixture()
    vi.mocked(reopened.operations.load).mockResolvedValue(result)
    expect(await reopened.controller.status()).toMatchObject({
      release: offer,
      error: 'check-failed',
    })
    expect(reopened.operations.discover).not.toHaveBeenCalled()
    await f.controller.dispose()
    await reopened.controller.dispose()
  })

  it('does not reuse compatibility cached for another installed package or an arbitrary URL', async () => {
    for (const stored of [
      { installedVersion: '0.1.0', officialVersion: '0.2.2-rc.1', release: offer },
      {
        installedVersion: '0.2.55',
        officialVersion: '0.2.2-rc.1',
        release: { ...offer, url: 'https://example.com/installer' },
      },
    ]) {
      const f = fixture()
      vi.mocked(f.operations.load).mockResolvedValue(stored)
      expect((await f.controller.status()).release).toBeNull()
      await f.controller.dispose()
    }
  })

  it('prepares the displayed release once, even for a local candidate, and cancels its pending plan', async () => {
    const f = fixture()
    await f.controller.check()
    await Promise.all([f.controller.prepare(), f.controller.prepare()])
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
    expect(f.operations.prepare).toHaveBeenCalledWith(expect.any(AbortSignal), offer.version)
    expect((await f.controller.status()).pendingVersion).toBe(offer.version)
    expect((await f.controller.cancel()).pendingVersion).toBeNull()
    await f.controller.dispose()
  })

  it('rejects enhancement preparation when the full Suite is required', async () => {
    const f = fixture()
    vi.mocked(f.operations.discover).mockResolvedValue({ ...offer, compatibility: 'full-suite' })
    await f.controller.check()
    await expect(f.controller.prepare()).rejects.toThrow('full Suite')
    expect(f.operations.prepare).not.toHaveBeenCalled()
    await f.controller.dispose()
  })

  it('waits for download cancellation before clearing its plan and rejects duplicate cancellation', async () => {
    const f = fixture()
    let ended = false
    vi.mocked(f.operations.prepare).mockImplementation(async (signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            ended = true
            resolve()
          },
          { once: true },
        ),
      )
    })
    vi.mocked(f.operations.cancel).mockImplementation(async () => {
      expect(ended).toBe(true)
    })
    await f.controller.check()
    const downloading = f.controller.prepare()
    await vi.waitFor(() => expect(f.operations.prepare).toHaveBeenCalledTimes(1))
    await Promise.all([f.controller.cancel(), f.controller.cancel(), downloading])
    expect(f.operations.cancel).toHaveBeenCalledTimes(1)
    expect((await f.controller.status()).preparing).toBe(false)
    await f.controller.dispose()
  })

  it('keeps a preparation failure visible without claiming that an update is ready', async () => {
    const f = fixture()
    vi.mocked(f.operations.prepare).mockRejectedValue(Error('checksum failed at private path'))
    await f.controller.check()
    expect(await f.controller.prepare()).toMatchObject({
      error: 'prepare-failed',
      pendingVersion: null,
      release: offer,
    })
    await f.controller.dispose()
  })

  it('checks after startup and at six-hour intervals, with a durable opt out', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.controller.start()
    await f.controller.status()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(f.operations.discover).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.operations.discover).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(f.operations.discover).toHaveBeenCalledTimes(2)
    await f.controller.setAutomatic(false)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(f.operations.discover).toHaveBeenCalledTimes(2)
    expect(f.operations.saveAutomatic).toHaveBeenCalledWith(false)
    await f.controller.check()
    expect(f.operations.discover).toHaveBeenCalledTimes(3)
    await f.controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts discovery and waits for owned work when unloaded', async () => {
    const f = fixture()
    vi.mocked(f.operations.discover).mockImplementation(async (_installed, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      return offer
    })
    const onChange = vi.fn()
    f.controller.subscribe(onChange)
    const work = f.controller.check()
    await vi.waitFor(() => expect(f.operations.discover).toHaveBeenCalledOnce())
    const count = onChange.mock.calls.length
    await f.controller.dispose()
    await work
    expect(onChange).toHaveBeenCalledTimes(count)
    expect(f.operations.save).not.toHaveBeenCalled()
    expect((await f.controller.status()).release).toBeNull()
  })

  it('publishes successful cancellation even when saving the display cache fails', async () => {
    const f = fixture()
    await f.controller.check()
    await f.controller.prepare()
    const changed = vi.fn()
    f.controller.subscribe(changed)
    vi.mocked(f.operations.save).mockRejectedValue(Error('disk unavailable'))
    expect(await f.controller.cancel()).toMatchObject({
      pendingVersion: null,
      error: 'prepare-failed',
    })
    expect(changed).toHaveBeenCalledOnce()
    expect((await f.controller.status()).pendingVersion).toBeNull()
    await f.controller.dispose()
  })

  it('waits for an already started preference write before unloading', async () => {
    const f = fixture()
    const write = deferred<void>()
    vi.mocked(f.operations.saveAutomatic).mockReturnValue(write.promise)
    const saving = f.controller.setAutomatic(false)
    await vi.waitFor(() => expect(f.operations.saveAutomatic).toHaveBeenCalledOnce())
    let disposed = false
    const unloading = f.controller.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    write.resolve()
    await Promise.all([saving, unloading])
    expect(disposed).toBe(true)
  })

  it('can reread local state after a transient initialization failure', async () => {
    const f = fixture()
    vi.mocked(f.operations.load).mockRejectedValueOnce(Error('temporary sharing violation'))
    await expect(f.controller.status()).rejects.toThrow('sharing violation')
    expect((await f.controller.status()).installedVersion).toBe('0.2.55')
    expect(f.operations.load).toHaveBeenCalledTimes(2)
    expect((await f.controller.check()).release).toEqual(offer)
    await f.controller.dispose()
  })
})
