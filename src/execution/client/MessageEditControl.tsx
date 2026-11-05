/** Composer edit cancellation and the shared history subscription. */
import { useEffect, useSyncExternalStore } from 'react'
import { IconCloseOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { messageEditCopy, type MessageEditSession } from './message-edit-session.ts'
import css from './StopEditControl.module.css'

export interface MessageEditProps {
  session: MessageEditSession
  inputActions: { setDraft(text: string): void }
  subscribeSession?: (id: string, listener: () => void) => () => void
  locked?: boolean
  onActiveChange?: (active: boolean) => void
}

/** Keep read retries mounted while message actions own all edit and recovery entries. */
export function MessageEditControl({
  session,
  inputActions,
  subscribeSession,
  locked = false,
  onActiveChange,
}: MessageEditProps) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const selection = snapshot.selection
  const expanded = selection !== undefined || snapshot.error !== undefined
  const retryable = snapshot.unavailable?.retryable === true

  useEffect(() => {
    void session.load()
    const off = subscribeSession?.(session.sessionId, () => void session.load())
    return () => off?.()
  }, [session, subscribeSession])

  useEffect(() => {
    if (!retryable) return
    let stopped = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout>
    const delays = [300, 1000]
    const schedule = () => {
      if (stopped || attempt >= delays.length) return
      timer = setTimeout(async () => {
        attempt++
        await session.retry()
        if (session.getSnapshot().unavailable?.retryable) schedule()
      }, delays[attempt])
    }
    schedule()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [session, retryable])

  useEffect(() => {
    onActiveChange?.(expanded)
    return () => onActiveChange?.(false)
  }, [expanded, onActiveChange])

  if (!expanded) return null
  return (
    <div className={css.root} data-opl-message-edit-state="">
      {selection ? (
        <Tooltip label={messageEditCopy.cancel} side="top">
          <button
            type="button"
            className={css.iconTrigger}
            aria-label={messageEditCopy.cancel}
            disabled={locked || snapshot.state?.busy || snapshot.state?.pending}
            onClick={() => {
              const previous = session.cancel()
              if (previous) inputActions.setDraft(previous.previousDraft)
            }}
          >
            <IconCloseOutlineRegular />
          </button>
        </Tooltip>
      ) : null}
      {snapshot.error ? (
        <button
          type="button"
          className={css.status}
          title="关闭提示"
          onClick={() => session.dismissError()}
        >
          {snapshot.error}
        </button>
      ) : null}
    </div>
  )
}
