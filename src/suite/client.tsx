/** One browser package, independently mounted feature lifecycles. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import './Conversation.module.css'
import remote from '../generated/remote.mjs'
import * as gateway from '../gateway/client/index.tsx'
import * as execution from '../execution/client/index.tsx'
import * as collaboration from '../collaboration/client/index.tsx'
import * as setup from '../setup/client/index.tsx'
import * as notifications from '../notifications/client/index.tsx'
import * as conversationStats from '../conversation-stats/client/index.tsx'
import * as autoReview from '../auto-review/client/index.tsx'
import { AUTO_REVIEW_NAMESPACE } from '../auto-review/client/locales.ts'
import type { AutoReviewSaveRequest } from '../auto-review/contracts/settings.ts'
import * as todoStatus from '../todo-status/client/index.tsx'
import * as settingsNavigation from '../compat/client/settings-navigation.ts'
import { optionalRemote, remoteCall } from '../shared/client/remote-call.ts'
export const inject = ['remote', 'slots', 'locale']
export async function apply(ctx: Context): Promise<void> {
  const dispose = await ctx.remote.$mount(remote)
  ctx.effect(() => dispose)
  ctx.plugin(settingsNavigation)
  let openModels: (() => void) | undefined
  ctx.plugin(gateway, { openModels: () => openModels?.() })
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
  ctx.plugin(collaboration)
  ctx.plugin(notifications)
  ctx.plugin(conversationStats)
  ctx.plugin(todoStatus)
  ctx.plugin(setup, {
    bindModelNavigation: (navigate: (() => void) | undefined) => {
      openModels = navigate
    },
  })
}
