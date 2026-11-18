import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'

/** Official permission settings own the future-session default. */
const SETTINGS_NS = 'permission'
const PERMISSION_PRESETS = new Set(['read-only', 'workspace-write', 'danger-full-access'])
type RememberedPreset = 'read-only' | 'workspace-write' | 'danger-full-access'
const sessionOnlySelections = new WeakSet<Session>()

/** A role narrows this Session without changing the person's default for later chats. */
export function withoutRememberingPermission<T>(session: Session, operation: () => T): T {
  sessionOnlySelections.add(session)
  try {
    return operation()
  } finally {
    sessionOnlySelections.delete(session)
  }
}

function officialPermissionSettings(ctx: Context) {
  return ctx.settings.describe().find((item) => item.ns === SETTINGS_NS)
}

function presetFrom(event: SessionEvent): RememberedPreset | undefined {
  if (event.type !== 'permission/preset') return
  const candidate = event.data.preset
  return typeof candidate === 'string' && PERMISSION_PRESETS.has(candidate)
    ? (candidate as RememberedPreset)
    : undefined
}

/**
 * Keep the last explicit built-in permission choice as the default for future native Sessions.
 * The official permission service initializes new Sessions from that default.
 * Initial pinning, seeded Sessions, subagents and role restrictions do not change it.
 * @param ctx - Official Host context containing settings and Session events.
 * @param enabled - Initial opt-in if the execution settings owner is absent.
 * @returns disposer for the event observers.
 */
export function installPermissionMemory(ctx: Context, enabled = false): () => void {
  const active = () => {
    const owner = ctx.settings.describe().find((item) => item.ns === 'opl-execution')
    if (!owner) return enabled
    return (owner.value as { rememberPermissionPreset?: boolean }).rememberPermissionPreset === true
  }
  const disposeEvent = ctx.on('session/event', (session, event) => {
    if (
      !active() ||
      session.header.origin === 'subagent' ||
      session.header.isSeeded ||
      sessionOnlySelections.has(session)
    )
      return
    const preset = presetFrom(event)
    if (!preset) return
    const events = session.snapshotEvents()
    if (events.some((entry) => entry.type === 'session/end-seed')) return
    // The first durable preset is the official Agent initialization, including
    // initialization when an existing Session is opened for the first time.
    if (events.find((entry) => entry.type === 'permission/preset')?.seq === event.seq) return
    const descriptor = officialPermissionSettings(ctx)
    if (!descriptor) return
    const value = descriptor.value as { defaultPreset?: string }
    if (value.defaultPreset === preset) return
    // The selection's revision prevents a later manual default edit from being
    // overwritten by this asynchronous write. The official settings owner
    // decides conflicts; this observer does not retry them.
    void ctx.settings
      .mutate(
        descriptor.ns,
        [{ op: 'set', path: ['defaultPreset'], value: preset }],
        descriptor.revision,
      )
      .catch((error) => {
        ctx.logger.warn(
          `permission memory update failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  })
  return disposeEvent
}
