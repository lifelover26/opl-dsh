/** Update controls contributed to the official General settings section. */
import { useSyncExternalStore } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateController } from './controller.ts'
import { PolicyControls } from './PolicyControls.tsx'
import { useUpdateCountdown } from './countdown.ts'
import css from '../../shared/client/SettingsSection.module.css'
import updatesCss from './Updates.module.css'

export type UpdatesSectionProps = PropsLocale<'settings.oplUpdates'> & {
  controller: UpdateController
}

/** @param props - Shared Host projection and typed locale. @returns General settings content. */
export function UpdatesSection({ controller, t }: UpdatesSectionProps) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { status, operation } = view
  const checking = operation === 'check' || Boolean(status?.checking)
  const preparing = operation === 'prepare' || Boolean(status?.preparing)
  const handoff = status?.restart?.phase === 'handoff'
  const busy = operation !== null || checking || preparing || handoff
  const writable = view.connected && view.confirmed && !busy && !view.uncertain && status !== null
  const failure = view.failure ?? status?.error
  const release = status?.release
  const restart = status?.restart
  const countdown = useUpdateCountdown(
    status?.pendingVersion && restart?.phase === 'countdown' ? restart.dueAt : null,
    view.connected && view.confirmed && !view.uncertain && !view.failure,
  )
  const latestCheckFoundNothing =
    status !== null &&
    status.lastSuccessAt !== null &&
    !release &&
    !status.localCandidate &&
    !status.pendingVersion &&
    !failure &&
    !busy &&
    view.connected

  return (
    <section className={css.section} data-opl-panel="updates" aria-label={t('title')}>
      <div className={css.officialRow}>
        <h3 className={css.name}>{t('title')}</h3>
        {status && (
          <dl className={css.facts}>
            <div>
              <dt className={css.factLabel}>{t('installedVersion')}</dt>
              <dd className={css.factValue}>{status.installedVersion}</dd>
            </div>
            <div>
              <dt className={css.factLabel}>{t('officialVersion')}</dt>
              <dd className={css.factValue}>{status.officialVersion}</dd>
            </div>
          </dl>
        )}
        {status?.localCandidate && <p className={css.notice}>{t('localCandidate')}</p>}
        <div className={css.row}>
          <span>{t('automatic')}</span>
          <Switch
            label={t('automatic')}
            checked={status?.automatic ?? false}
            disabled={!writable}
            onChange={(enabled) => void controller.setAutomatic(enabled)}
          />
        </div>
        <p className={css.muted}>{t('automaticHelp')}</p>
        <PolicyControls controller={controller} status={status} writable={writable} t={t} />
        <div className={updatesCss.actions}>
          <Button
            variant="outline"
            disabled={!view.connected || Boolean(busy)}
            onClick={() => void controller.check()}
          >
            {t(checking ? 'checking' : 'check')}
          </Button>
          {view.failure && (
            <Button
              variant="outline"
              disabled={!view.connected || operation !== null}
              onClick={() => controller.refresh()}
            >
              {t('refreshStatus')}
            </Button>
          )}
        </div>
        {!view.connected && (
          <p role="status" className={css.muted}>
            {t('disconnected')}
          </p>
        )}
        {operation === 'status' && (
          <p role="status" className={css.muted}>
            {t('loading')}
          </p>
        )}
        {operation === 'automatic' && (
          <p role="status" className={css.muted}>
            {t('saving')}
          </p>
        )}
        {operation === 'policy' && (
          <p role="status" className={css.muted}>
            {t('savingPolicy')}
          </p>
        )}
        {operation === 'postpone' && (
          <p role="status" className={css.muted}>
            {t('postponing')}
          </p>
        )}
        {operation === 'cancel' && (
          <p role="status" className={css.muted}>
            {t('cancelling')}
          </p>
        )}
        {status?.checkedAt ? (
          <p className={css.muted}>
            {t('lastChecked')}:{' '}
            <time dateTime={status.checkedAt}>{new Date(status.checkedAt).toLocaleString()}</time>
          </p>
        ) : status ? (
          <p className={css.muted}>{t('neverChecked')}</p>
        ) : null}
        {status?.lastSuccessAt && status.lastSuccessAt !== status.checkedAt && (
          <p className={css.muted}>
            {t('lastSuccess')}:{' '}
            <time dateTime={status.lastSuccessAt}>
              {new Date(status.lastSuccessAt).toLocaleString()}
            </time>
          </p>
        )}
        {failure && (
          <p role="alert" className={css.error}>
            {t(failure)}
          </p>
        )}
        {latestCheckFoundNothing && (
          <p role="status" className={css.muted}>
            {t('noUpdate')}
          </p>
        )}
        {release && (
          <div className={css.card} data-opl-update-release={release.version}>
            <h3 className={css.name}>{t('release', { version: release.version })}</h3>
            <p className={css.muted}>
              {t('releaseOfficialVersion')}: {release.officialVersion}
            </p>
            <p className={css.muted}>
              {t('publishedAt')}:{' '}
              <time dateTime={release.publishedAt}>
                {new Date(release.publishedAt).toLocaleString()}
              </time>
            </p>
            <p className={css.muted}>
              {t(release.compatibility === 'enhancement' ? 'enhancement' : 'fullSuite')}
            </p>
            <a
              className={updatesCss.link}
              href={release.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('releaseNotes')}
            </a>
            {release.compatibility === 'full-suite' ? (
              <a
                className={updatesCss.link}
                href={release.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('download')}
              </a>
            ) : (
              !status?.pendingVersion && (
                <Button
                  variant="outline"
                  disabled={!writable}
                  onClick={() => void controller.prepare()}
                >
                  {t(preparing ? 'preparing' : 'prepare')}
                </Button>
              )
            )}
          </div>
        )}
        {preparing && (
          <div className={css.notice}>
            <p role="status">{t('preparing')}</p>
            <Button
              variant="ghost"
              disabled={!controller.canCancel()}
              onClick={() => void controller.cancel()}
            >
              {t('cancelDownload')}
            </Button>
          </div>
        )}
        {status?.pendingVersion && !preparing && (
          <div className={css.notice} data-opl-update-pending={status.pendingVersion}>
            <p role={countdown !== null ? 'timer' : 'status'}>
              {t(
                handoff
                  ? 'restartHandoff'
                  : countdown !== null
                    ? 'restartCountdown'
                    : restart?.phase === 'waiting'
                      ? 'restartWaiting'
                      : 'pending',
                { version: status.pendingVersion, seconds: countdown ?? 0 },
              )}
            </p>
            {restart?.phase === 'waiting' && restart.reason && (
              <p className={css.muted}>{t(restart.reason)}</p>
            )}
            {restart?.phase === 'failed' && (
              <p className={css.muted}>{t(restart.reason ?? 'update-failed')}</p>
            )}
            {!handoff && (
              <div className={updatesCss.actions}>
                {restart?.phase === 'countdown' && (
                  <Button
                    variant="ghost"
                    disabled={!controller.canPostpone()}
                    onClick={() => void controller.postpone()}
                  >
                    {t(operation === 'postpone' ? 'postponing' : 'postpone')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={!controller.canCancel()}
                  onClick={() => void controller.cancel()}
                >
                  {t(operation === 'cancel' ? 'cancelling' : 'cancel')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
