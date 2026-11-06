/** Official user-message layout with one message-local edit action. */
import { useEffect, useRef, useState } from 'react'
import {
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ChatNodeViewProps,
  UserContentAttachment,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRenderSlots, SessionIdOf, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MessageEditSession } from './message-edit-session.ts'
import { MessageEditAction } from './MessageEditAction.tsx'
import css from './MessageEditUserRow.module.css'

export type MessageEditUserRowProps = ChatNodeViewProps<'user'> &
  PropsRenderSlots<'conversation.chat.user.before'> & {
    readonly sessionId: SessionIdOf
    edit: MessageEditSession
  }

/**
 * Decorate the official user row while retaining its message-source child slot.
 * @param slots - official registration inspection and change subscription.
 * @param messageEditFor - edit state belonging to the rendered Session.
 * @returns disposer restoring the resident row unless another plugin replaced it.
 */
export function installMessageEditUserRows(
  slots: Pick<SlotRegistry, 'entries' | 'subscribe'>,
  messageEditFor: (sessionId: string) => MessageEditSession,
): () => void {
  type ResidentProps = Omit<MessageEditUserRowProps, 'edit'>
  let resident:
    | {
        entry: StoredEntry
        original: unknown
        decorated: (props: ResidentProps) => ReturnType<typeof MessageEditUserRow>
      }
    | undefined
  const restore = () => {
    if (resident === undefined) return
    const { entry, original, decorated } = resident
    resident = undefined
    if (entry.component === decorated) entry.component = original
  }
  const reconcile = () => {
    const entry = slots
      .entries('conversation.chat.node')
      .find(
        (entry) =>
          entry.options.key === 'user' &&
          entry.children?.['conversation.chat.user.before'] !== undefined,
      )
    if (entry === resident?.entry) return
    restore()
    if (entry === undefined) return
    const original = entry.component
    const decorated = (props: ResidentProps) => (
      <MessageEditUserRow {...props} edit={messageEditFor(props.sessionId)} />
    )
    entry.component = decorated
    resident = { entry, original, decorated }
  }
  const off = slots.subscribe('conversation.chat.node', reconcile)
  reconcile()
  return () => {
    off()
    restore()
  }
}

/** Use the official prepared-content Factory and keep the official row geometry. */
export function MessageEditUserRow({
  node,
  loadImage,
  renderFactorySlot,
  renderSlotChain,
  edit,
  useInput,
  inputActions,
  t,
}: MessageEditUserRowProps) {
  const draft = useInput((input) => input.draft) ?? ''
  const day = useCalendarDay()
  const text = node.data.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
  const attachments: UserContentAttachment[] = node.data.content.flatMap((block) => {
    if (block.type === 'image' && block.attachment)
      return [{ type: 'image', image: { attachment: block.attachment } }]
    if (block.type === 'file' && block.attachment) return [{ type: 'file', file: block.attachment }]
    return [] as UserContentAttachment[]
  })
  const extraBlocks = node.data.content.filter(
    (block) => block.type !== 'text' && block.type !== 'image' && block.type !== 'file',
  )
  const content = {
    text,
    attachments,
    extraBlocks,
    ...('referenceLabels' in node.data && node.data.referenceLabels
      ? { referenceLabels: node.data.referenceLabels }
      : {}),
  }
  const facts = {
    ...(node.data.referenceLabels ? { sessionLabels: node.data.referenceLabels } : {}),
    ...(node.data.skillNames ? { skillNames: node.data.skillNames } : {}),
  }
  const time = formatMessageClock(node.data.time, t, day)
  return (
    <div className={css.row}>
      {renderSlotChain(
        'conversation.chat.user.before',
        { source: node.data.source, kind: node.kind },
        { fallback: null },
      )}
      {renderFactorySlot('conversation.chat.user.content', {
        content,
        loadImage,
        facts,
        interactive: true,
      })}
      <div className={css.actions}>
        <span className={css.time}>{time}</span>
        <Tooltip label={t('copy')} side="bottom">
          <CopyAction text={text} label={t('copy')} copiedLabel={t('copied')} />
        </Tooltip>
        <MessageEditAction
          session={edit}
          seq={node.data.seq}
          draft={draft}
          retainsImages={attachments.some((part) => part.type === 'image')}
          onDraft={(text) => inputActions.setDraft(text)}
        />
      </div>
    </div>
  )
}

function CopyAction({
  text,
  label,
  copiedLabel,
}: {
  text: string
  label: string
  copiedLabel: string
}) {
  const [copied, setCopied] = useState(false)
  const pending = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      pending.current = false
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      className={css.action}
      aria-label={copied ? copiedLabel : label}
      onClick={async () => {
        if (copied || pending.current) return
        pending.current = true
        const accepted = await writeClipboard(text)
        pending.current = false
        if (!accepted) return
        setCopied(true)
        timer.current = setTimeout(() => {
          timer.current = null
          setCopied(false)
        }, 1000)
      }}
    >
      {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
    </button>
  )
}

function useCalendarDay(): number {
  const [day, setDay] = useState(() => startOfLocalDay(Date.now()))
  useEffect(() => {
    const arm = () => {
      const now = Date.now()
      setDay(startOfLocalDay(now))
      timer = setTimeout(arm, msUntilNextLocalMidnight(now))
    }
    let timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()))
    return () => clearTimeout(timer)
  }, [])
  return day
}

function startOfLocalDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function msUntilNextLocalMidnight(time: number): number {
  const next = new Date(time)
  next.setHours(24, 0, 0, 0)
  return Math.max(1, next.getTime() - time)
}

function formatMessageClock(time: number, t: MessageEditUserRowProps['t'], day: number): string {
  const date = new Date(time)
  const current = new Date(day)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate()
  )
    return clock
  const params = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
  return `${date.getFullYear() === current.getFullYear() ? t('clock.md', params) : t('clock.ymd', params)} ${clock}`
}
