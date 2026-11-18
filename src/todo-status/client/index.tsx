/**
 * Read-only todo status panel.
 *
 * It takes over the official `conversation.input.dock` cell `id: 'todo'` at a
 * lower shadowing priority — the shipped registration is never removed and
 * stays on the ledger as the fallback — so the panel can report that a stopped
 * Session's unfinished items are unfinished instead of leaving the shipped
 * endless `in_progress` rotation on screen. It is display only: no todo is
 * written, no Session is cancelled or resumed, no model request is made, and
 * the recorded statuses are shown unchanged.
 *
 * @module todo-status/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TodoStatusConfig } from './config.ts'
import { TODO_STATUS_NAMESPACE, en, zh } from './locales.ts'
import { TodoStatusDock } from './TodoStatusDock.tsx'

export type { TodoStatusConfig } from './config.ts'

/** Client selection for the optional OPL todo replacement. */
export interface TodoStatusClientConfig {
  enabled?: boolean
}

/** Services this plugin reads; it reaches nothing else. */
export const inject = ['slots', 'locale']

/**
 * Mount the read-only todo panel over the shipped dock cell.
 * @param ctx - official Client root context.
 * @param config - optional child-status seam (see {@link TodoStatusConfig}).
 * @returns nothing.
 */
export function apply(ctx: Context, config?: TodoStatusConfig & TodoStatusClientConfig): void {
  ctx.effect(() => ctx.locale.register(TODO_STATUS_NAMESPACE, { zh, en }))
  if (config?.enabled === false) return
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        // Same cell as the shipped entry, at a lower shadowing rank (ascending,
        // lowest renders). The shipped entry keeps priority 0 and takes the cell
        // back automatically if this one abdicates.
        id: 'todo',
        priority: -1,
        order: 0,
        locale: TODO_STATUS_NAMESPACE,
        inject: () => ({ readChildStatus: config?.readChildStatus }),
      },
      TodoStatusDock,
    ),
  )
}
