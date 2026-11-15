import { mountRemotes } from '../shared/client/mount-remotes.ts'
/** One browser package, independently mounted feature lifecycles. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import './Conversation.module.css'
import * as gateway from '../gateway/client/index.tsx'
import * as setup from '../setup/client/index.tsx'
import * as notifications from '../notifications/client/index.tsx'
import * as conversationStats from '../conversation-stats/client/index.tsx'
import * as todoStatus from '../todo-status/client/index.tsx'
import * as settingsNavigation from '../compat/client/settings-navigation.ts'
import * as updates from '../updates/client/index.tsx'
import * as windowTitle from '../window-title/client/index.tsx'
import { subscribeUpdateWatch } from '../updates/client/watch.ts'
import { optionalRemote, remoteCall } from '../shared/client/remote-call.ts'
export const inject = ['remote', 'slots', 'locale']
export async function apply(ctx: Context): Promise<void> {
  await mountRemotes(ctx, ['oplSetup', 'oplGatewayAccount', 'oplGatewayModels', 'oplUpdates'])
  ctx.plugin(settingsNavigation)
  let openModels: (() => void) | undefined
  let openSettings: (() => void) | undefined
  ctx.plugin(gateway, { openModels: () => openModels?.() })
  ctx.plugin(notifications)
  ctx.plugin(conversationStats)
  ctx.plugin(windowTitle)
  ctx.plugin(todoStatus)
  const updateRemote = optionalRemote(ctx, 'oplUpdates')
  if (updateRemote) {
    const call = remoteCall(updateRemote)
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    const updateConnection = connection
      ? {
          getSnapshot: () => connection.generation.getSnapshot()?.id,
          subscribe: (listener: () => void) => connection.generation.subscribe(listener),
        }
      : undefined
    ctx.plugin(updates, {
      api: {
        status: () => call('status'),
        check: () => call('check'),
        setAutomatic: (enabled: boolean) => call('automatic', enabled),
        prepare: () => call('prepare'),
        cancel: () => call('cancel'),
        setPolicy: (policy) => call('policy', policy),
        postpone: () => call('postpone'),
        activity: () => call('activity'),
      },
      ...(updateConnection ? { connection: updateConnection } : {}),
      subscribe: (listener: () => void) =>
        subscribeUpdateWatch(() => updateRemote.watch(), listener, updateConnection),
      openSettings: () => openSettings?.(),
    })
  }
  ctx.plugin(setup, {
    bindModelNavigation: (navigate: (() => void) | undefined) => {
      openModels = navigate
    },
    bindSettingsNavigation: (navigate: (() => void) | undefined) => {
      openSettings = navigate
    },
  })
}
