/** Prepare the Agent's selection, then admit its exact frozen official request. */
import type { Context } from '@deepseek-ai/cordis'
import type { HarnessService } from './harness.ts'

/**
 * Normalize selections before step preparation and validate requests before edit admission.
 * @param ctx - Host effect scope.
 * @param harness - Owner of execution combinations and edit transactions.
 * @returns Disposer for the initialization and request listeners.
 */
export function installConversationRequest(ctx: Context, harness: HarnessService): () => void {
  const disposeModel = ctx.on('agent/created', async ({ agent, signal }) => {
    await harness.prepareConversationModel(agent, signal)
    return undefined
  })
  const disposeRequest = ctx.on(
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
  return () => {
    disposeRequest()
    disposeModel()
  }
}
