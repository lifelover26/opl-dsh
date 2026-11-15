import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { mountRemotes } from '../shared/client/mount-remotes.ts'
import { optionalRemote, remoteCall } from '../shared/client/remote-call.ts'
import * as execution from '../execution/client/index.tsx'
import * as autoReview from '../auto-review/client/index.tsx'
import { AUTO_REVIEW_NAMESPACE } from '../auto-review/client/locales.ts'
import type { AutoReviewSaveRequest } from '../auto-review/contracts/settings.ts'
export const inject = ['remote', 'slots', 'locale']
export async function apply(ctx: Context): Promise<void> {
  await mountRemotes(ctx, ['oplExecution', 'oplAutoReview'], '@one-person-lab/dsh-execution')
  const autoReviewRemote = optionalRemote(ctx, 'oplAutoReview')
  let autoReviewSeat
  if (autoReviewRemote) {
    ctx.plugin(autoReview)
    const call = remoteCall(autoReviewRemote)
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    autoReviewSeat = {
      api: {
        read: () => call('read'),
        save: (request: AutoReviewSaveRequest) => call('save', request),
      },
      ...(connection
        ? {
            connection: {
              getSnapshot: () => connection.generation.getSnapshot()?.id,
              subscribe: (listener: () => void) => connection.generation.subscribe(listener),
            },
          }
        : {}),
      t: ctx.locale.bind(AUTO_REVIEW_NAMESPACE),
    }
  }
  ctx.plugin(execution, { ...(autoReviewSeat ? { autoReview: autoReviewSeat } : {}) })
}
