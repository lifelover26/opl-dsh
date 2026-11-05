/** Message-local edit action, placed beside the official copy action. */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { IconEditOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  messageEditCopy,
  messageEditUnavailableCopy,
  type MessageEditSession,
} from './message-edit-session.ts'
import css from './MessageEditAction.module.css'

export function MessageEditAction({
  session,
  seq,
  draft,
  onDraft,
}: {
  session: MessageEditSession
  seq: number
  draft: string
  onDraft(text: string): void
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const current = useRef({ session, seq, draft, onDraft })
  current.current = { session, seq, draft, onDraft }
  const mounted = useRef(false)
  const selecting = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const choice = session.choice(seq)
  const unavailable = snapshot.unavailable
  if (
    snapshot.state?.supported === false ||
    (!choice && !(snapshot.state?.supported && unavailable))
  )
    return null
  const busy = snapshot.state?.busy === true || snapshot.state?.pending === true
  const label = unavailable?.retryable ? messageEditCopy.retry : '编辑消息'
  const hint = busy
    ? messageEditCopy.stop
    : unavailable
      ? `${messageEditUnavailableCopy[unavailable.reason]}${unavailable.retryable ? '，点击重试' : ''}`
      : label
  return (
    <Tooltip label={hint} side="bottom">
      <button
        type="button"
        className={css.action}
        aria-label={label}
        aria-disabled={busy || (unavailable && !unavailable.retryable) || undefined}
        data-unavailable={busy || unavailable !== undefined || undefined}
        onClick={async () => {
          if (busy) return
          if (unavailable) {
            if (unavailable.retryable) await session.retry()
            return
          }
          if (!choice || selecting.current) return
          selecting.current = true
          const flight = session.select(seq, draft)
          const selection = session.getSnapshot().selection
          const selected = await flight
          selecting.current = false
          if (!selected || !selection) return
          const latest = current.current
          if (
            !mounted.current ||
            latest.session !== session ||
            latest.seq !== seq ||
            latest.draft !== draft ||
            session.getSnapshot().selection !== selection
          ) {
            if (session.getSnapshot().selection === selection) session.cancel()
            return
          }
          latest.onDraft(choice.text)
        }}
      >
        <IconEditOutlineRegular />
      </button>
    </Tooltip>
  )
}
