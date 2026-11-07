import type { Context } from '@deepseek-ai/cordis'
import { useEffect } from 'react'
import { SetupScreen, type SetupActions } from './SetupScreen.tsx'
import { AccountLauncher } from './AccountLauncher.tsx'
import { remoteCall, optionalRemote } from '../../shared/client/remote-call.ts'
import type { OplGatewaySectionInjected } from '../../gateway/client/OplGatewaySection.tsx'
export const inject = ['slots', 'locale', 'remote.oplSetup']
/** Account availability is checked only when choosing Gateway; official setup remains usable. */
export function apply(
  ctx: Context,
  navigation: {
    bindModelNavigation: (navigate: (() => void) | undefined) => void
    bindSettingsNavigation?: (navigate: (() => void) | undefined) => void
  },
): void {
  const call = remoteCall(ctx.remote.oplSetup)
  const account = () => {
    const service = optionalRemote(ctx, 'oplGatewayAccount')
    if (!service) throw new Error('OPL Gateway 暂不可用，可选择官方账户或稍后设置。')
    return remoteCall(service)
  }
  const actions: SetupActions & OplGatewaySectionInjected = {
    readSetup: () => call('status'),
    finish: async (choice) => {
      await call('finish', choice)
    },
    startOfficial: async () => {
      await call('official-start')
    },
    cancelOfficial: async () => {
      await call('official-cancel')
    },
    saveOfficialKey: async (key) => {
      await call('official-key', key)
    },
    status: () => account()('status'),
    signIn: (email, password, remember) => account()('signIn', email, password, remember),
    rememberedLogin: () => account()('rememberedLogin'),
    signInRemembered: (email) => account()('signInRemembered', email),
    forgetPassword: () => account()('forgetPassword'),
    refresh: () => account()('refresh'),
    signOut: () => account()('signOut'),
  }
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'opl-setup',
        locale: 'settings.oplGateway',
        inject: () => actions,
      },
      (props) => <SetupScreen {...props} close={() => {}} />,
    ),
  )
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register(
      {
        name: 'settings.onboarding',
        id: 'opl-account',
        order: 100,
        locale: 'settings.oplGateway',
        inject: () => actions,
      },
      (props) =>
        props.explicit ? (
          <SetupScreen {...props} explicit close={props.complete} />
        ) : (
          <SkipAccountStep complete={props.complete} />
        ),
    ),
  )
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register(
      {
        name: 'settings.onboarding',
        id: 'opl-model-navigation',
        order: 101,
      },
      (props) => <SectionNavigationStep {...props} section="models" />,
    ),
  )
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register(
      {
        name: 'settings.onboarding',
        id: 'opl-update-navigation',
        order: 102,
      },
      (props) => <SectionNavigationStep {...props} section="general" />,
    ),
  )
  ctx.slots.inject('settings.launcher', () =>
    ctx.slots.register(
      {
        name: 'settings.launcher',
        priority: -10,
        locale: 'settings.oplGateway',
        inject: () => ({
          readAccount: actions.status,
          bindModelNavigation: navigation.bindModelNavigation,
          ...(navigation.bindSettingsNavigation
            ? { bindSettingsNavigation: navigation.bindSettingsNavigation }
            : {}),
        }),
      },
      AccountLauncher,
    ),
  )
}
function SkipAccountStep({ complete }: { complete: () => void }) {
  useEffect(complete, [complete])
  return null
}
function SectionNavigationStep({
  complete,
  openSection,
  explicit,
  section,
}: {
  complete: () => void
  openSection: (id: string) => void
  explicit?: boolean
  section: string
}) {
  useEffect(() => {
    complete()
    if (explicit) openSection(section)
  }, [complete, openSection, explicit, section])
  return null
}
