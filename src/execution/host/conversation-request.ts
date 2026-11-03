/** Admit the exact official request before the LLM resolves provider reasoning controls. */
import type { Context } from '@deepseek-ai/cordis'
import type { HarnessService } from './harness.ts'

/**
 * Keep native model-selection listeners inside the request admission check.
 * @param ctx - Host effect scope.
 * @param harness - Owner of execution combinations and edit transactions.
 * @returns Disposer for the request listener.
 */
export function installConversationRequest(ctx: Context, harness: HarnessService): () => void {
  return ctx.on(
    'agent/request',
    async (payload, next) => {
      harness.assertRuntimeAvailable()
      const request = await harness.prepareConversationRequest(
        payload.agent.session.id,
        await next(),
      )
      payload.signal.throwIfAborted()
      harness.assertRuntimeAvailable()
      const edited = await harness.commitMessageEdit(
        payload.agent,
        payload.turn,
        payload.step,
        payload.signal,
      )
      await harness.assertConversationEditable(payload.agent.session.id, edited)
      payload.signal.throwIfAborted()
      harness.assertRuntimeAvailable()
      return request
    },
    { prepend: true },
  )
}
