import { useEffect, useState } from 'react'
import {
  IconEllipsisOutlineMedium,
  IconSettingsOutlineMedium,
  IconUserOutlineMedium,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GatewayAccountStatus } from '../../gateway/contracts/account.ts'
import { subscribeAccountChanges } from '../../gateway/client/account-changes.ts'
import css from './AccountLauncher.module.css'

/** The official settings shell owns navigation; this launcher chooses the account. */
export function AccountLauncher({
  wide,
  settingsOpen,
  settingsShortcut,
  openSettings,
  openOnboarding,
  readAccount,
  bindModelNavigation,
  bindSettingsNavigation,
  t,
}: PropsRuntime<'settings.launcher'> &
  PropsLocale<'settings.oplGateway'> & {
    readAccount: () => Promise<GatewayAccountStatus>
    bindModelNavigation: (navigate: (() => void) | undefined) => void
    bindSettingsNavigation?: (navigate: (() => void) | undefined) => void
  }) {
  useEffect(() => {
    bindModelNavigation(() => openOnboarding('opl-model-navigation'))
    return () => bindModelNavigation(undefined)
  }, [bindModelNavigation, openOnboarding])
  useEffect(() => {
    bindSettingsNavigation?.(() => openOnboarding('opl-update-navigation'))
    return () => bindSettingsNavigation?.(undefined)
  }, [bindSettingsNavigation, openOnboarding])
  const [open, setOpen] = useState(false)
  const [account, setAccount] = useState<GatewayAccountStatus>()
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeAccountChanges(() => setRevision((value) => value + 1)), [])
  useEffect(() => {
    let active = true
    void Promise.resolve()
      .then(readAccount)
      .then((status) => {
        if (active) {
          setAccount(status)
          setFailed(false)
        }
      })
      .catch(() => {
        if (active) {
          setAccount(undefined)
          setFailed(true)
        }
      })
    return () => {
      active = false
    }
  }, [readAccount, settingsOpen, open, revision])
  const connected = account?.phase === 'connected'
  const label = connected
    ? account.account?.email?.trim() || t('accountSignedIn')
    : t(failed || account?.phase === 'unavailable' ? 'unavailable' : 'accountSignedOut')
  return (
    <Menu
      open={open}
      side="top"
      portal
      autoFocus
      className={css.root}
      anchor={
        <button
          type="button"
          className={css.trigger}
          data-collapsed={!wide}
          aria-label={t('accountMenu')}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {connected ? (
            <IconUserOutlineMedium size={16} />
          ) : (
            <IconEllipsisOutlineMedium size={14} />
          )}
          {wide && <span className={css.label}>{label}</span>}
        </button>
      }
      items={[
        {
          id: 'settings',
          label: t('accountSettings'),
          icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut ? { shortcut: settingsShortcut } : {}),
        },
        {
          id: 'account',
          label: t(connected ? 'accountTitle' : 'signIn'),
          icon: <IconUserOutlineMedium size={16} />,
        },
      ]}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'settings') openSettings()
        else openOnboarding('opl-account')
      }}
    />
  )
}
