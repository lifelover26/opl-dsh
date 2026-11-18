import { useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NativeShellStatus } from './contracts/selection.ts'
import css from '../shared/client/SettingsSection.module.css'

export const nativeShellLabels = {
  zh: {
    title: 'DSH 使用 Git Bash',
    description:
      '仅限 Windows。默认使用官方 PowerShell；启用后，standard、cordis、ptc 预设的 Shell 工具使用 Git Bash；minimal 的持久终端保持官方配置。关闭时恢复原配置。停止活动任务后可保存，重启 OPL DSH 后生效。',
    failed: 'Shell 设置未能保存，请重试。',
    restart: '已保存，重启 OPL DSH 后生效。',
  },
  en: {
    title: 'Use Git Bash for DSH',
    description:
      'Windows only. Official PowerShell is the default. Enable Git Bash for standard, cordis and ptc shell tools; minimal persistent terminals retain official settings. Turning it off restores the original configuration. Stop active tasks before saving. Restart OPL DSH to apply.',
    failed: 'Could not save the shell preference. Please try again.',
    restart: 'Saved. Restart OPL DSH to apply.',
  },
} as const
export interface NativeShellApi {
  read(): Promise<NativeShellStatus>
  select(enabled: boolean): Promise<NativeShellStatus>
}
/** Read back the actual Loader choice after every explicit selection. */
export function NativeShellPreference({
  api,
  t,
}: { api: NativeShellApi } & PropsLocale<'settings.oplNativeShell'>) {
  const [state, setState] = useState<NativeShellStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void api
      .read()
      .then((value) => {
        if (live) setState(value)
      })
      .catch(() => {
        if (live) setError(t('failed'))
      })
    return () => {
      live = false
    }
  }, [api, t])
  return (
    <div className={css.officialRow} data-opl-preference="native-shell">
      <div className={css.preferenceContent}>
        <div className={css.preferenceText}>
          <h3 className={css.preferenceTitle}>{t('title')}</h3>
          <p className={css.preferenceDescription}>{t('description')}</p>
        </div>
        <Switch
          label={t('title')}
          checked={state?.desired ?? state?.enabled === true}
          disabled={busy || !state?.available}
          onChange={(enabled) => {
            if (busy || !state?.available || enabled === (state.desired ?? state.enabled)) return
            setBusy(true)
            setError('')
            void api
              .select(enabled)
              .then(setState)
              .catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : t('failed'))
              })
              .finally(() => setBusy(false))
          }}
        />
      </div>
      {(error || state?.pending || state?.reason) && (
        <p role="alert" className={css.error}>
          {error || state?.reason || t('restart')}
        </p>
      )}
    </div>
  )
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplNativeShell': keyof typeof nativeShellLabels.zh
  }
}
