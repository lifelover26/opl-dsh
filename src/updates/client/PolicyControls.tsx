/** Three update choices share the existing General settings owner. */
import { useEffect, useId, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OplUpdateStatus } from '../contracts.ts'
import type { UpdateController } from './controller.ts'
import { updatePolicy, validUpdatePolicy } from './policy.ts'
import css from '../../shared/client/SettingsSection.module.css'
import updatesCss from './Updates.module.css'

export type PolicyControlsProps = PropsLocale<'settings.oplUpdates'> & {
  controller: UpdateController
  status: OplUpdateStatus | null
  writable: boolean
}

/** @param props - Accepted preferences and write availability. @returns Mode and optional timing controls. */
export function PolicyControls({ controller, status, writable, t }: PolicyControlsProps) {
  const policy = updatePolicy(status)
  const id = useId()
  const [idleMinutes, setIdleMinutes] = useState(String(policy.idleMinutes))
  const [countdownSeconds, setCountdownSeconds] = useState(String(policy.countdownSeconds))
  useEffect(() => {
    setIdleMinutes(String(policy.idleMinutes))
    setCountdownSeconds(String(policy.countdownSeconds))
  }, [policy.idleMinutes, policy.countdownSeconds])
  const edited =
    idleMinutes !== String(policy.idleMinutes) ||
    countdownSeconds !== String(policy.countdownSeconds)
  const draft = {
    mode: policy.mode,
    idleMinutes: Number(idleMinutes),
    countdownSeconds: Number(countdownSeconds),
  }
  const valid = validUpdatePolicy(draft)
  return (
    <>
      <label className={css.field}>
        <span>{t('policy')}</span>
        <select
          className={css.input}
          value={policy.mode}
          disabled={!writable}
          onChange={(event) => {
            const mode = event.target.value
            if (mode === 'notify' || mode === 'on-launch' || mode === 'idle')
              void controller.setPolicy({ ...policy, mode })
          }}
        >
          <option value="notify">{t('modeNotify')}</option>
          <option value="on-launch">{t('modeOnLaunch')}</option>
          <option value="idle">{t('modeIdle')}</option>
        </select>
      </label>
      <p className={css.muted}>
        {t(
          policy.mode === 'notify'
            ? 'modeNotifyHelp'
            : policy.mode === 'on-launch'
              ? 'modeOnLaunchHelp'
              : 'modeIdleHelp',
          { idleMinutes: policy.idleMinutes, countdownSeconds: policy.countdownSeconds },
        )}
      </p>
      {policy.mode === 'idle' && (
        <details className={css.details}>
          <summary>{t('timing')}</summary>
          <div className={css.detailsBody}>
            <div className={updatesCss.timingFields}>
              <label className={css.field}>
                <span>{t('idleMinutes')}</span>
                <input
                  className={css.input}
                  type="number"
                  min={1}
                  max={120}
                  step={1}
                  value={idleMinutes}
                  disabled={!writable}
                  aria-invalid={edited && !valid}
                  aria-describedby={edited && !valid ? `${id}-range` : undefined}
                  onChange={(event) => setIdleMinutes(event.target.value)}
                />
              </label>
              <label className={css.field}>
                <span>{t('countdownSeconds')}</span>
                <input
                  className={css.input}
                  type="number"
                  min={15}
                  max={300}
                  step={1}
                  value={countdownSeconds}
                  disabled={!writable}
                  aria-invalid={edited && !valid}
                  aria-describedby={edited && !valid ? `${id}-range` : undefined}
                  onChange={(event) => setCountdownSeconds(event.target.value)}
                />
              </label>
            </div>
            {edited && !valid && (
              <p id={`${id}-range`} role="alert" className={css.error}>
                {t('timingRange')}
              </p>
            )}
            <Button
              variant="outline"
              disabled={!writable || !edited || !valid}
              onClick={() => void controller.setPolicy(draft)}
            >
              {t('saveTiming')}
            </Button>
          </div>
        </details>
      )}
    </>
  )
}
