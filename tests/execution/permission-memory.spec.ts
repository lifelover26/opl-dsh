import { afterEach, expect, it, vi } from 'vitest'
import {
  installPermissionMemory,
  withoutRememberingPermission,
} from '../../src/compat/host/permission-memory.ts'

type Handler = (...args: any[]) => void

function fixture(lastPermissionPreset: string = 'workspace-write', existingIds: string[] = []) {
  const handlers = new Map<string, Handler>()
  const settings = {
    describe: vi.fn(() => [{ ns: 'opl-suite', value: { lastPermissionPreset }, revision: 4 }]),
    mutate: vi.fn(async () => undefined),
  }
  const permissionPresets = {
    current: vi.fn(() => 'workspace-write'),
    set: vi.fn(),
  }
  const ctx = {
    sessions: { list: () => existingIds.map((id) => ({ id })) },
    settings,
    permissionPresets,
    logger: { warn: vi.fn() },
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    }),
  }
  const dispose = installPermissionMemory(ctx as never)
  return { ctx, settings, permissionPresets, handlers, dispose }
}

afterEach(() => vi.restoreAllMocks())

function session(id: string, isSeeded = false, eventCount = 1) {
  return {
    id,
    header: { isSeeded },
    snapshotEvents: () => Array.from({ length: eventCount }, () => ({ type: 'permission/preset' })),
  }
}

it('uses the in-process choice before its settings write resolves', async () => {
  const f = fixture()
  const current = session('current')
  f.handlers.get('session/created')!(current)
  f.handlers.get('session/event')!(current, {
    type: 'permission/preset',
    data: { preset: 'danger-full-access' },
  })
  const fresh = session('fresh', false, 3)
  f.handlers.get('session/created')!(fresh)
  await Promise.resolve()
  expect(f.permissionPresets.set).toHaveBeenCalledWith(fresh, 'danger-full-access')
  f.dispose()
})

it('applies the remembered preset after official initial permission pinning', async () => {
  const f = fixture('danger-full-access')
  const fresh = session('fresh', false, 3)
  f.handlers.get('session/created')!(fresh)
  await Promise.resolve()
  expect(f.permissionPresets.set).toHaveBeenCalledExactlyOnceWith(fresh, 'danger-full-access')
  f.dispose()
})

it('does not widen an existing or seeded Session', () => {
  const f = fixture('danger-full-access', ['existing'])
  const existing = session('existing')
  const seeded = session('seeded', true, 2)
  f.handlers.get('session/created')!(existing)
  f.handlers.get('session/created')!(seeded)
  expect(f.permissionPresets.set).not.toHaveBeenCalled()
  f.dispose()
})

it('persists only supported explicit preset events', async () => {
  const f = fixture()
  const known = session('known')
  f.handlers.get('session/created')!(known)
  f.handlers.get('session/event')!(known, {
    type: 'permission/preset',
    data: { preset: 'danger-full-access' },
  })
  await Promise.resolve()
  expect(f.settings.mutate).toHaveBeenCalledWith(
    'opl-suite',
    [{ op: 'set', path: ['lastPermissionPreset'], value: 'danger-full-access' }],
    4,
  )
  f.settings.mutate.mockClear()
  f.handlers.get('session/event')!(known, {
    type: 'permission/preset',
    data: { preset: 'auto' },
  })
  await Promise.resolve()
  expect(f.settings.mutate).not.toHaveBeenCalled()
  f.dispose()
})

it('keeps delegated permissions and role restrictions out of global defaults', async () => {
  const f = fixture('danger-full-access')
  const member = { ...session('member'), header: { isSeeded: false, origin: 'subagent' } }
  f.handlers.get('session/created')!(member)
  f.handlers.get('session/event')!(member, {
    type: 'permission/preset',
    data: { preset: 'read-only' },
  })
  const role = session('role')
  f.handlers.get('session/created')!(role)
  withoutRememberingPermission(role as never, () =>
    f.handlers.get('session/event')!(role, {
      type: 'permission/preset',
      data: { preset: 'read-only' },
    }),
  )
  await Promise.resolve()
  expect(f.permissionPresets.set).not.toHaveBeenCalledWith(member, expect.anything())
  expect(f.permissionPresets.set).toHaveBeenCalledWith(role, 'danger-full-access')
  expect(f.settings.mutate).not.toHaveBeenCalled()
  f.dispose()
})
