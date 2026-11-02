/** Official permission presets shared by delegated and ordinary conversations. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { HarnessSession } from '../contracts/sessions.ts'

/**
 * Harnesses whose official CLI can carry an explicitly authorized full-access task.
 *
 * Each entry is backed by a real official mechanism rather than a loosened guard:
 * - `dsh` uses the official persistent `danger-full-access` permission preset.
 * - `minimax-code` advertises a Full access mode matching the task authorization.
 * - `codex` and `claude` are projected through the native ACP bridge, which maps the
 *   authorization onto the official `danger-full-access` sandbox with `approval_policy
 *   = "never"`, and for Claude the official `bypassPermissions` mode.
 *
 * - `grok-build` maps full access to the official `off` sandbox and
 *   `bypassPermissions` mode; restricted Windows tasks are rejected by its adapter.
 */
const FULL_ACCESS_HARNESSES: ReadonlySet<string> = new Set([
  'dsh',
  'minimax-code',
  'codex',
  'claude',
  'grok-build',
  'zcode',
  'kimi-code',
  'mimo-code',
  'pool',
  'step-code',
  'muse-code',
  'opencode',
  'pi',
  'kilo',
  'vibe',
])

/**
 * Whether a harness may receive an explicitly authorized full-access task.
 *
 * A harness outside this set keeps the previous behaviour: a requested full-access task
 * is reported as unsupported rather than silently downgraded or silently widened.
 * @param harnessRef - harness reference from the catalog.
 * @returns true only for harnesses with a verified official full-access path.
 */
export function harnessAllowsFullAccess(harnessRef: string): boolean {
  return FULL_ACCESS_HARNESSES.has(harnessRef)
}

/** Return the built-in preset matching the task's authorized filesystem access. */
export function harnessPermissionPreset(sandbox: HarnessSession['sandbox']): string {
  switch (sandbox) {
    case 'full-access':
      return 'danger-full-access'
    case 'workspace':
      return 'workspace-write'
    case 'read-only':
      return 'read-only'
  }
}

/** Set both permission knobs through their official owner, including durable preset identity. */
export function setHarnessPermissions(
  ctx: Context,
  session: Session,
  sandbox: HarnessSession['sandbox'],
): void {
  const owner = ctx.get('permissionPresets')
  if (!owner) throw Error('Official permission preset service is unavailable')
  owner.set(session, harnessPermissionPreset(sandbox))
}
