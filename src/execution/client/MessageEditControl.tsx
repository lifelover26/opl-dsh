/** Exceptional edit controls; the message action owns normal selection. */
import { useEffect, useSyncExternalStore } from 'react'
import { IconCloseOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  messageEditCopy,
  messageEditUnavailableCopy,
  type MessageEditSession,
} from './message-edit-session.ts'
import css from './StopEditControl.module.css'

export interface MessageEditProps {
  session: MessageEditSession
  inputActions: { setDraft(text: string): void }
  subscribeSession?: (id: string, listener: () => void) => () => void
  locked?: boolean
  onActiveChange?: (active: boolean) => void
}

/** Composer controls for cancelling an edit, retrying history, and confirming recovery. */
export function MessageEditControl({
  session,
  inputActions,
  subscribeSession,
  locked = false,
  onActiveChange,
}: MessageEditProps) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const selection = snapshot.selection
  const unavailable = snapshot.unavailable
  const recovery =
    !locked && !snapshot.state?.busy && !unavailable ? snapshot.state?.recovery : undefined
  const expanded = selection !== undefined || recovery !== undefined || snapshot.error !== undefined
  const visible = expanded || unavailable !== undefined
  const retryable = unavailable?.retryable === true

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

  if (!visible) return null
  return (
    <div className={css.root} data-opl-message-edit-state="">
      {recovery ? (
        <button
          type="button"
          className={css.trigger}
          disabled={locked || snapshot.state?.busy}
          onClick={() => void session.recover()}
        >
          {messageEditCopy.recover}
        </button>
      ) : null}
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
      {unavailable ? (
        <Tooltip label={messageEditUnavailableCopy[unavailable.reason]} side="top">
          {retryable ? (
            <button
              type="button"
              className={css.trigger}
              disabled={locked}
              data-opl-message-edit-retry=""
              onClick={() => void session.retry()}
            >
              {messageEditCopy.retry}
            </button>
          ) : (
            <span className={css.status}>{messageEditCopy.unavailable}</span>
          )}
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
