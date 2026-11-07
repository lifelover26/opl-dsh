/** Idle restart races use virtual time and explicit RPC barriers, without installer or desktop access. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OplUpdatePolicy,
  OplUpdateRelease,
  OplUpdateRestart,
  OplUpdateStatus,
} from '../../src/updates/contracts.ts'
import {
  defaultUpdatePolicy,
  IdleUpdateCoordinator,
  updatePolicy,
} from '../../src/updates/host/idle.ts'
import { UpdateController, type UpdateOperations } from '../../src/updates/host/controller.ts'

const cleanups: (() => void | Promise<unknown>)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-11-07T05:00:00.000Z')
})
afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()!()
  } finally {
    vi.useRealTimers()
  }
})

function deferred<T>(fallback: T) {
  const gate = Promise.withResolvers<T>()
  cleanups.push(() => gate.resolve(fallback))
  return gate
}

const offer: OplUpdateRelease = {
  version: '0.3.0',
  officialVersion: '0.2.2-rc.1',
  url: 'https://github.com/gaofeng21cn/opl-dsh/releases/tag/opl-dsh-v0.3.0',
  publishedAt: '2026-11-07T00:00:00Z',
  compatibility: 'enhancement',
}
const policy = (overrides: Partial<OplUpdatePolicy> = {}): OplUpdatePolicy => ({
  mode: 'idle',
  idleMinutes: 1,
  countdownSeconds: 15,
  ...overrides,
})
function status(overrides: Partial<OplUpdateStatus> = {}): OplUpdateStatus {
  return {
    installedVersion: '0.2.55',
    officialVersion: offer.officialVersion,
    localCandidate: false,
    automatic: false,
    checking: false,
    preparing: false,
    checkedAt: null,
    lastSuccessAt: null,
    error: null,
    release: offer,
    pendingVersion: null,
    policy: policy(),
    ...overrides,
  }
}
function coordinatorFixture(initial = status()) {
  let state = initial
  const operations = {
    status: vi.fn(() => state),
    prepare: vi.fn(async () => {
      state.pendingVersion = state.release!.version
    }),
    inspect: vi.fn(async (): Promise<OplUpdateRestart['reason']> => null),
    handoff: vi.fn(async () => {}),
    publish: vi.fn((restart: OplUpdateRestart | undefined) => {
      state.restart = restart
    }),
  }
  const coordinator = new IdleUpdateCoordinator(operations)
  cleanups.push(() => coordinator.dispose())
  return {
    coordinator,
    operations,
    get state() {
      return state
    },
    change(patch: Partial<OplUpdateStatus>) {
      state = { ...state, ...patch }
      coordinator.changed()
    },
  }
}
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('unattended update policy validation', () => {
  it('keeps reminder defaults and accepts both numeric endpoints', () => {
    expect(defaultUpdatePolicy).toEqual({ mode: 'notify', idleMinutes: 5, countdownSeconds: 30 })
    expect(updatePolicy(policy())).toEqual(policy())
    expect(updatePolicy(policy({ idleMinutes: 120, countdownSeconds: 300 }))).toEqual(
      policy({ idleMinutes: 120, countdownSeconds: 300 }),
    )
  })

  it.each([
    null,
    {},
    policy({ mode: 'unexpected' as OplUpdatePolicy['mode'] }),
    policy({ idleMinutes: 0 }),
    policy({ idleMinutes: 121 }),
    policy({ idleMinutes: 1.5 }),
    policy({ countdownSeconds: 14 }),
    policy({ countdownSeconds: 301 }),
    policy({ countdownSeconds: 15.5 }),
  ])('rejects invalid persisted or remote preferences %#', (value) => {
    expect(() => updatePolicy(value)).toThrow('Invalid update policy')
  })
})

describe('idle coordinator release and time ownership', () => {
  it.each([
    status({ policy: policy({ mode: 'notify' }) }),
    status({ localCandidate: true }),
    status({ release: { ...offer, compatibility: 'full-suite' } }),
    status({ release: null }),
  ])('never prepares or restarts excluded release state %#', async (initial) => {
    const f = coordinatorFixture(initial)
    f.coordinator.changed()
    await tick(24 * 60 * 60_000)
    expect(f.operations.prepare).not.toHaveBeenCalled()
    expect(f.operations.inspect).not.toHaveBeenCalled()
    expect(f.operations.handoff).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('automatically prepares on-launch policy without inspecting or scheduling a restart', async () => {
    const f = coordinatorFixture(status({ policy: policy({ mode: 'on-launch' }) }))
    f.coordinator.changed()
    await tick(24 * 60 * 60_000)
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
    expect(f.state.pendingVersion).toBe(offer.version)
    expect(f.operations.inspect).not.toHaveBeenCalled()
    expect(f.operations.handoff).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits the exact idle interval and countdown before one handoff', async () => {
    const f = coordinatorFixture()
    f.coordinator.changed()
    await tick()
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
    expect(f.state.restart).toEqual({ phase: 'waiting', dueAt: null, reason: null })
    await tick(59_999)
    expect(f.operations.handoff).not.toHaveBeenCalled()
    expect(f.state.restart?.phase).toBe('waiting')
    await tick(1)
    expect(f.state.restart).toEqual({
      phase: 'countdown',
      dueAt: '2026-11-07T05:01:15.000Z',
      reason: null,
    })
    await tick(14_999)
    expect(f.operations.handoff).not.toHaveBeenCalled()
    await tick(1)
    expect(f.operations.handoff).toHaveBeenCalledTimes(1)
    expect(f.state.restart?.phase).toBe('handoff')
    f.coordinator.changed()
    f.coordinator.activity()
    await tick(60 * 60_000)
    expect(f.operations.handoff).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restarts the full idle interval after real input during the countdown', async () => {
    const f = coordinatorFixture()
    f.coordinator.changed()
    await tick(70_000)
    expect(f.state.restart?.phase).toBe('countdown')
    f.coordinator.activity()
    await tick()
    expect(f.state.restart?.phase).toBe('waiting')
    await tick(59_999)
    expect(f.operations.handoff).not.toHaveBeenCalled()
    await tick(1)
    expect(f.state.restart).toEqual({
      phase: 'countdown',
      dueAt: '2026-11-07T05:02:25.000Z',
      reason: null,
    })
    await tick(15_000)
    expect(f.operations.handoff).toHaveBeenCalledTimes(1)
  })

  it.each(['busy', 'activity-unknown', 'other-profile', 'desktop-unavailable'] as const)(
    'resets elapsed idle time while waiting for %s',
    async (reason) => {
      const f = coordinatorFixture()
      f.coordinator.changed()
      await tick(60_000)
      f.operations.inspect.mockResolvedValue(reason)
      f.coordinator.changed()
      await tick()
      expect(f.state.restart).toEqual({ phase: 'waiting', dueAt: null, reason })
      await tick(60_000)
      f.operations.inspect.mockResolvedValue(null)
      f.coordinator.changed()
      await tick()
      await tick(59_999)
      expect(f.operations.handoff).not.toHaveBeenCalled()
      expect(f.state.restart?.phase).toBe('waiting')
      await tick(1)
      expect(f.state.restart?.phase).toBe('countdown')
      await tick(15_000)
      expect(f.operations.handoff).toHaveBeenCalledTimes(1)
    },
  )

  it('treats a rejected activity inspection as unknown and requires a new complete idle interval', async () => {
    const f = coordinatorFixture()
    f.operations.inspect.mockRejectedValueOnce(Error('activity provider unavailable'))
    f.coordinator.changed()
    await tick()
    expect(f.state.restart).toEqual({ phase: 'waiting', dueAt: null, reason: 'activity-unknown' })
    await tick(59_999)
    expect(f.operations.handoff).not.toHaveBeenCalled()
    await tick(1)
    expect(f.state.restart?.phase).toBe('countdown')
  })

  it('does not hand off a stale inspection after user activity invalidates it', async () => {
    const f = coordinatorFixture(status({ pendingVersion: offer.version }))
    const gate = deferred<OplUpdateRestart['reason']>(null)
    f.operations.inspect.mockImplementationOnce(() => gate.promise)
    f.coordinator.changed()
    await tick()
    expect(f.operations.inspect).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 60_000)
    f.coordinator.activity()
    gate.resolve(null)
    await gate.promise
    await tick()
    expect(f.operations.handoff).not.toHaveBeenCalled()
    expect(f.state.restart?.phase).toBe('waiting')
  })

  it('clears a countdown when switching to reminder policy', async () => {
    const f = coordinatorFixture()
    f.coordinator.changed()
    await tick(60_000)
    f.change({ policy: policy({ mode: 'notify' }) })
    await tick(60_000)
    expect(f.state.restart).toBeUndefined()
    expect(f.operations.handoff).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not restart after preparation is invalidated by a policy switch', async () => {
    const f = coordinatorFixture()
    const gate = deferred<void>(undefined)
    f.operations.prepare.mockImplementationOnce(async () => {
      await gate.promise
      f.state.pendingVersion = offer.version
    })
    f.coordinator.changed()
    await tick()
    f.change({ policy: policy({ mode: 'notify' }) })
    gate.resolve()
    await gate.promise
    await tick(120_000)
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
    expect(f.operations.inspect).not.toHaveBeenCalled()
    expect(f.operations.handoff).not.toHaveBeenCalled()
  })

  it('does not use an older prepared plan for a newer release', async () => {
    const f = coordinatorFixture(status({ pendingVersion: '0.2.99' }))
    f.coordinator.changed()
    await tick(75_000)
    expect(f.operations.prepare).not.toHaveBeenCalled()
    expect(f.state.pendingVersion).toBe('0.2.99')
    expect(f.operations.handoff).not.toHaveBeenCalled()
    expect(f.state.restart).toEqual({ phase: 'failed', dueAt: null, reason: 'update-failed' })
  })
})

describe('idle coordinator failure and teardown', () => {
  it('suppresses a failed handoff for that release until explicit postponement', async () => {
    const f = coordinatorFixture()
    f.operations.handoff.mockRejectedValueOnce(Error('desktop handoff failed'))
    f.coordinator.changed()
    await tick(75_000)
    expect(f.state.restart).toEqual({ phase: 'failed', dueAt: null, reason: 'update-failed' })
    for (let i = 0; i < 3; i++) {
      f.coordinator.changed()
      await tick(120_000)
    }
    expect(f.operations.handoff).toHaveBeenCalledTimes(1)
    f.coordinator.postpone()
    await tick(75_000)
    expect(f.operations.handoff).toHaveBeenCalledTimes(2)
  })

  it('permits a newer release after another release failed', async () => {
    const f = coordinatorFixture()
    f.operations.handoff.mockRejectedValueOnce(Error('desktop handoff failed'))
    f.coordinator.changed()
    await tick(75_000)
    f.change({ release: { ...offer, version: '0.3.1' }, pendingVersion: null })
    await tick(75_000)
    expect(f.operations.prepare).toHaveBeenCalledTimes(2)
    expect(f.state.pendingVersion).toBe('0.3.1')
    expect(f.operations.handoff).toHaveBeenCalledTimes(2)
  })

  it('claims handoff before awaiting it and rejects postponement or input mutation during it', async () => {
    const f = coordinatorFixture()
    const gate = deferred<void>(undefined)
    f.operations.handoff.mockReturnValueOnce(gate.promise)
    f.coordinator.changed()
    await tick(75_000)
    expect(f.operations.handoff).toHaveBeenCalledTimes(1)
    expect(f.state.restart?.phase).toBe('handoff')
    f.coordinator.activity()
    f.coordinator.changed()
    expect(f.state.restart?.phase).toBe('handoff')
    expect(() => f.coordinator.postpone()).toThrow('handoff')
    gate.resolve()
    await gate.promise
    await tick(120_000)
    expect(f.operations.handoff).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('awaits a pending inspection on dispose and suppresses its late result', async () => {
    const f = coordinatorFixture()
    const gate = deferred<OplUpdateRestart['reason']>(null)
    f.operations.inspect.mockReturnValueOnce(gate.promise)
    f.coordinator.changed()
    await tick()
    let disposed = false
    const work = f.coordinator.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    const publications = f.operations.publish.mock.calls.length
    gate.resolve(null)
    await work
    expect(disposed).toBe(true)
    expect(f.operations.publish).toHaveBeenCalledTimes(publications)
    expect(f.operations.handoff).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('awaits a started handoff on dispose and suppresses a late handoff rejection', async () => {
    const f = coordinatorFixture()
    const gate = deferred<void>(undefined)
    f.operations.handoff.mockReturnValueOnce(gate.promise)
    f.coordinator.changed()
    await tick(75_000)
    let disposed = false
    const work = f.coordinator.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    const publications = f.operations.publish.mock.calls.length
    gate.reject(Error('handoff failed after unload'))
    await work
    expect(disposed).toBe(true)
    expect(f.operations.publish).toHaveBeenCalledTimes(publications)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records a rejected preparation once and does not reject disposal', async () => {
    const f = coordinatorFixture()
    f.operations.prepare.mockRejectedValueOnce(Error('download rejected'))
    f.coordinator.changed()
    await tick()
    expect(f.state.restart).toEqual({ phase: 'failed', dueAt: null, reason: 'update-failed' })
    f.coordinator.changed()
    await tick(120_000)
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
    await expect(f.coordinator.dispose()).resolves.toBeUndefined()
  })
})

function hostFixture(overrides: Partial<OplUpdateStatus> = {}) {
  const initial = status(overrides)
  let selected = initial.policy!
  let pending = initial.pendingVersion
  const operations = {
    installed: vi.fn(async () => ({
      suiteVersion: initial.installedVersion,
      officialVersion: initial.officialVersion,
      localCandidate: initial.localCandidate,
    })),
    automatic: () => false,
    saveAutomatic: vi.fn(async () => {}),
    load: vi.fn(async () => initial),
    save: vi.fn(async () => {}),
    discover: vi.fn(async () => initial.release),
    pending: vi.fn(async () => pending),
    prepare: vi.fn(async (_signal: AbortSignal, expected: string) => {
      pending = expected
    }),
    cancel: vi.fn(async () => {
      pending = null
    }),
    policy: () => selected,
    savePolicy: vi.fn(async (value: OplUpdatePolicy) => {
      selected = value
    }),
    inspect: vi.fn(async (): Promise<OplUpdateRestart['reason']> => null),
    handoff: vi.fn(async () => {}),
  } satisfies UpdateOperations
  const controller = new UpdateController(operations)
  cleanups.push(() => controller.dispose())
  return { operations, controller }
}

describe('Host idle coordinator integration', () => {
  it('keeps a cancelled automatic update cancelled for the same offered release', async () => {
    const f = hostFixture()
    f.controller.start()
    await f.controller.status()
    await tick(1000)
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
    expect((await f.controller.cancel()).pendingVersion).toBeNull()
    await tick(120_000)
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
    expect(f.operations.handoff).not.toHaveBeenCalled()
    expect((await f.controller.status()).pendingVersion).toBeNull()
  })

  it('does not retry one failed automatic preparation after its own status invalidation', async () => {
    const f = hostFixture()
    f.operations.prepare.mockRejectedValue(Error('download checksum failed'))
    f.controller.start()
    await f.controller.status()
    await tick(5000)
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
    expect(await f.controller.status()).toMatchObject({
      pendingVersion: null,
      restart: { phase: 'failed' },
    })
    await tick(60 * 60_000)
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
  })

  it('switches an active countdown to on-launch policy without restarting or downloading again', async () => {
    const f = hostFixture()
    f.controller.start()
    await f.controller.status()
    await tick(60_000)
    expect((await f.controller.status()).restart?.phase).toBe('countdown')
    await f.controller.setPolicy(policy({ mode: 'on-launch' }))
    await tick(60_000)
    expect((await f.controller.status()).restart).toBeUndefined()
    expect(f.operations.prepare).toHaveBeenCalledTimes(1)
    expect(f.operations.handoff).not.toHaveBeenCalled()
    expect(f.operations.savePolicy).toHaveBeenCalledExactlyOnceWith(policy({ mode: 'on-launch' }))
  })

  it('rejects a postpone during handoff without first erasing the handoff status', async () => {
    const f = hostFixture()
    const gate = deferred<void>(undefined)
    f.operations.handoff.mockReturnValueOnce(gate.promise)
    f.controller.start()
    await f.controller.status()
    await tick(75_000)
    expect((await f.controller.status()).restart?.phase).toBe('handoff')
    await expect(f.controller.postpone()).rejects.toThrow()
    expect((await f.controller.status()).restart?.phase).toBe('handoff')
    await f.controller.activity()
    expect((await f.controller.status()).restart?.phase).toBe('handoff')
  })
})
