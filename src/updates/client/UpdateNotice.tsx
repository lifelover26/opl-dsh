/** A persistent status at the official sidebar foot; no toast or system notification. */
import { useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateController } from './controller.ts'
import { useUpdateCountdown } from './countdown.ts'
import css from './Updates.module.css'

export type UpdateNoticeProps = PropsRuntime<'sidebar.footer.action'> &
  PropsLocale<'settings.oplUpdates'> & {
    controller: UpdateController
    openSettings?: () => void
  }

/** @param props - Sidebar geometry, shared status, and existing settings navigation. @returns Release notice. */
export function UpdateNotice({ controller, openSettings, wide, t }: UpdateNoticeProps) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const status = view.status
  const restart = status?.restart
  const countdown = useUpdateCountdown(
    status?.pendingVersion && restart?.phase === 'countdown' ? restart.dueAt : null,
    view.connected && view.confirmed && !view.uncertain && !view.failure,
  )
  if (!status || (!status.release && !status.pendingVersion)) return null
  const version = status.pendingVersion ?? status.release!.version
  const label = t(
    status.pendingVersion
      ? restart?.phase === 'handoff'
        ? 'noticeHandoff'
        : countdown !== null
          ? 'noticeCountdown'
          : restart?.phase === 'waiting'
            ? 'noticeWaiting'
            : 'noticePending'
      : status.release!.compatibility === 'full-suite'
        ? 'noticeFullSuite'
        : 'noticeAvailable',
    { version, seconds: countdown ?? 0 },
  )
  const title =
    view.failure || status.error || !view.connected || !view.confirmed || view.uncertain
      ? `${label} ${t('noticeStale')}`
      : label
  const content = (
    <>
      {(wide || countdown === null) && <span aria-hidden="true">↑</span>}
      {countdown !== null ? (
        <span>
          {t(wide ? 'noticeCountdownShort' : 'noticeCountdownCompact', { seconds: countdown })}
        </span>
      ) : (
        wide && <span>{t('noticeShort')}</span>
      )}
    </>
  )
  const notice = openSettings ? (
    <Button
      className={css.notice}
      variant="ghost"
      size="sm"
      title={title}
      aria-label={title}
      data-opl-update-notice={version}
      onClick={openSettings}
    >
      {content}
    </Button>
  ) : status.release ? (
    <a
      className={css.notice}
      href={status.release.url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      aria-label={title}
      data-opl-update-notice={version}
    >
      {content}
    </a>
  ) : (
    <span className={css.notice} title={title} aria-label={title} data-opl-update-notice={version}>
      {content}
    </span>
  )
  return (
    <div className={css.noticeGroup}>
      {notice}
      {wide && restart?.phase === 'countdown' && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!controller.canPostpone()}
          onClick={() => void controller.postpone()}
        >
          {t(view.operation === 'postpone' ? 'postponing' : 'postpone')}
        </Button>
      )}
    </div>
  )
}
