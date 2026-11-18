import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'

/** Official permission settings own the future-session default. */
const SETTINGS_NS = 'permission'
const PERMISSION_PRESETS = new Set(['read-only', 'workspace-write', 'danger-full-access'])
type RememberedPreset = 'read-only' | 'workspace-write' | 'danger-full-access'
const sessionOnlySelections = new WeakSet<Session>()

/** Apply a session-local preset without changing the person's default for later chats. */
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
  let pending: { preset: RememberedPreset; revision: number } | undefined
  let writing = false
  const persist = async () => {
    if (writing) return
    writing = true
    try {
      while (pending) {
        const { preset, revision } = pending
        pending = undefined
        try {
          const descriptor = officialPermissionSettings(ctx)
          if (!active() || !descriptor || descriptor.revision !== revision) continue
          if ((descriptor.value as { defaultPreset?: string }).defaultPreset === preset) continue
          await ctx.settings.mutate(
            descriptor.ns,
            [{ op: 'set', path: ['defaultPreset'], value: preset }],
            revision,
          )
          const saved = officialPermissionSettings(ctx)
          // A queued choice may advance over our successful write, but not over
          // an intervening manual change to the official default.
          const next = pending as { preset: RememberedPreset; revision: number } | undefined
          if (
            next?.revision === revision &&
            saved?.revision === revision + 1 &&
            (saved.value as { defaultPreset?: string }).defaultPreset === preset
          )
            next.revision = saved.revision
        } catch (error) {
          ctx.logger.warn(
            `permission memory update failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    } finally {
      writing = false
    }
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
    // Keep the newest choice even if it currently matches the persisted value:
    // an earlier in-flight write may still change that value.
    pending = { preset, revision: descriptor.revision }
    void persist()
  })
  return () => {
    pending = undefined
    disposeEvent()
  }
}
