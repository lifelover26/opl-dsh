import { SETTINGS_ORDER } from '../../shared/client/settings-navigation.ts'
import type { Context } from '@deepseek-ai/cordis'
import { CoordinationSection } from './CoordinationSection.tsx'
import { remoteCall, optionalRemote } from '../../shared/client/remote-call.ts'
export const inject = ['slots', 'remote.oplCoordination']
export function apply(ctx: Context): void {
  const call = remoteCall(ctx.remote.oplCoordination)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'opl-codex',
        order: SETTINGS_ORDER['opl-codex'],
        label: () => '协作与自动化',
        inject: () => {
          // Optional execution settings must not block Skill/install settings.
          const execution = optionalRemote(ctx, 'oplExecution')
          const roles = optionalRemote(ctx, 'oplRoleExecution')
          return {
            call,
            ...(execution ? { executionCall: remoteCall(execution) } : {}),
            ...(roles ? { roleCall: remoteCall(roles) } : {}),
          }
        },
      },
      CoordinationSection,
    ),
  )
}
