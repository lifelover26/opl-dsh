/** Publish current-history conversation counts through the official projection registry. */
import type { Context } from '@deepseek-ai/cordis'
import { conversationCountsProjection } from './projection.ts'

/** Cordis plugin identity. */
export const name = 'opl-conversation-stats'

/** The official registry owns persistence, replay, and projection delivery. */
export const inject = ['sessionProjections']

/**
 * Register the count projection for this plugin's lifetime.
 * @param ctx - Host context with the official session-projection service.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(conversationCountsProjection)
}
