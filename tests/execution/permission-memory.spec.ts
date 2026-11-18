import { afterEach, expect, it, vi } from 'vitest'
import {
  installPermissionMemory,
  withoutRememberingPermission,
} from '../../src/compat/host/permission-memory.ts'

function fixture(initialDefault = 'workspace-write', initialEnabled = true) {
  type Event = { type: string; seq: number; data: { preset?: string } }
  type Session = {
    id: string
    header: { isSeeded?: boolean; origin?: string }
    snapshotEvents(): Event[]
  }
  const listeners = new Set<(session: Session, event: Event) => void>()
  let defaultPreset = initialDefault
  let revision = 4
  let enabled = initialEnabled
  const settings = {
    describe: vi.fn(() => [
      { ns: 'permission', value: { defaultPreset }, revision },
      { ns: 'opl-execution', value: { rememberPermissionPreset: enabled }, revision: 1 },
    ]),
    mutate: vi.fn(async (_ns: string, ops: { value: string }[], expectedRevision: number) => {
      if (expectedRevision !== revision) return { ok: false }
      defaultPreset = ops[0]!.value
      revision += 1
      return { ok: true }
    }),
  }
  const permissionPresets = { current: vi.fn(), set: vi.fn() }
  const ctx = {
    settings,
    permissionPresets,
    logger: { warn: vi.fn() },
    on: vi.fn((name: string, listener: (session: Session, event: Event) => void) => {
      expect(name).toBe('session/event')
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
  }
  const install = () => installPermissionMemory(ctx as never, false)
  let dispose = install()
  function session(id: string, header: Session['header'] = {}) {
    const events: Event[] = []
    const session: Session = { id, header, snapshotEvents: () => events }
    const append = (type: string, preset?: string) => {
      const event = { type, seq: events.length, data: preset === undefined ? {} : { preset } }
      events.push(event)
      for (const listener of listeners) listener(session, event)
    }
    return { session, append, events }
  }
  return {
    ctx,
    settings,
    permissionPresets,
    session,
    get defaultPreset() {
      return defaultPreset
    },
    get revision() {
      return revision
    },
    setEnabled(value: boolean) {
      enabled = value
    },
    manualDefault(value: string) {
      defaultPreset = value
      revision += 1
    },
    reopen() {
      dispose()
      dispose = install()
    },
    dispose() {
      dispose()
    },
  }
}

afterEach(() => vi.restoreAllMocks())

it('leaves initial permissions to the official service without applying or caching a second value', async () => {
  const f = fixture('danger-full-access')
  const fresh = f.session('fresh')
  fresh.append('permission/preset', 'danger-full-access')
  await Promise.resolve()
  expect(f.settings.mutate).not.toHaveBeenCalled()
  expect(f.permissionPresets.set).not.toHaveBeenCalled()
  expect(f.ctx.on).toHaveBeenCalledTimes(1)
  f.dispose()
})

it('writes a supported explicit selection to the official default only', async () => {
  const f = fixture()
  const current = f.session('current')
  current.append('permission/preset', 'workspace-write')
  current.append('permission/preset', 'danger-full-access')
  await Promise.resolve()
  expect(f.settings.mutate).toHaveBeenCalledExactlyOnceWith(
    'permission',
    [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }],
    4,
  )
  expect(f.defaultPreset).toBe('danger-full-access')
  expect(f.permissionPresets.set).not.toHaveBeenCalled()
  current.append('permission/preset', 'auto')
  current.append('permission/preset', 'invalid')
  current.append('sandbox/mode')
  expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  f.dispose()
})

it('does not remember a first-time initialization when an existing Session is opened', async () => {
  const f = fixture('danger-full-access')
  const existing = f.session('existing')
  existing.append('user/message')
  existing.append('permission/preset', 'workspace-write')
  await Promise.resolve()
  expect(f.settings.mutate).not.toHaveBeenCalled()
  expect(f.defaultPreset).toBe('danger-full-access')
  f.dispose()
})

it('does not persist selections while disabled, including after re-enabling and reopening', async () => {
  const f = fixture('workspace-write', false)
  const current = f.session('current')
  current.append('permission/preset', 'workspace-write')
  current.append('permission/preset', 'danger-full-access')
  expect(f.settings.mutate).not.toHaveBeenCalled()
  f.setEnabled(true)
  f.reopen()
  expect(f.defaultPreset).toBe('workspace-write')
  expect(f.permissionPresets.set).not.toHaveBeenCalled()
  current.append('permission/preset', 'read-only')
  await Promise.resolve()
  expect(f.defaultPreset).toBe('read-only')
  f.setEnabled(false)
  current.append('permission/preset', 'danger-full-access')
  expect(f.defaultPreset).toBe('read-only')
  f.dispose()
})

it('preserves a manually edited official default across new Sessions and observer reopening', async () => {
  const f = fixture()
  const current = f.session('current')
  current.append('permission/preset', 'workspace-write')
  current.append('permission/preset', 'danger-full-access')
  f.manualDefault('read-only')
  f.setEnabled(false)
  f.reopen()
  f.setEnabled(true)
  const fresh = f.session('fresh')
  fresh.append('permission/preset', 'read-only')
  await Promise.resolve()
  expect(f.defaultPreset).toBe('read-only')
  expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  expect(f.permissionPresets.set).not.toHaveBeenCalled()
  f.dispose()
})

it('does not retry a delayed selection over a later manual default edit', async () => {
  const f = fixture()
  const mutate = f.settings.mutate.getMockImplementation()!
  let release!: () => void
  f.settings.mutate.mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return mutate(...args)
  })
  const current = f.session('current')
  current.append('permission/preset', 'workspace-write')
  current.append('permission/preset', 'danger-full-access')
  f.manualDefault('read-only')
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(f.defaultPreset).toBe('read-only')
  expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  f.dispose()
})

it('keeps seeded sessions, subagents and role restrictions out of official defaults', async () => {
  const f = fixture()
  for (const header of [{ isSeeded: true }, { origin: 'subagent' }]) {
    const seeded = f.session('seeded', header)
    seeded.append('permission/preset', 'workspace-write')
    seeded.append('permission/preset', 'danger-full-access')
  }
  const seeded = f.session('durable-seed')
  seeded.append('permission/preset', 'workspace-write')
  seeded.append('session/end-seed')
  seeded.append('permission/preset', 'danger-full-access')
  const role = f.session('role')
  role.append('permission/preset', 'workspace-write')
  withoutRememberingPermission(role.session as never, () =>
    role.append('permission/preset', 'read-only'),
  )
  await Promise.resolve()
  expect(f.settings.mutate).not.toHaveBeenCalled()
  expect(f.permissionPresets.set).not.toHaveBeenCalled()
  f.dispose()
})
