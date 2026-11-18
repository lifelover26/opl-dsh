/**
 * Read-only replacement for the shipped `todo` dock cell.
 *
 * It takes the official `conversation.input.dock` cell at a lower shadowing
 * priority, so the shipped registration stays on the ledger as the fallback,
 * and it renders nothing but the public `todos` projection, the Session run
 * state, and the direct-child observation. It never writes a todo, never
 * cancels or resumes a Session, and never asks a model for anything.
 *
 * @module todo-status/client/TodoStatusDock
 */
import { useId, useState } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  IconChecklistOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListSeat, SessionStatusSeat } from './seats.ts'
import { TODO_STATUS_NAMESPACE } from './locales.ts'
import { ACTIVITY_LABEL_KEY, projectTodoPanel, type TodoCounts } from './todo-display.ts'
import css from './TodoStatusDock.module.css'

/** Framework `t` seat of this entry's namespace. */
type TodoTranslate = PropsLocale<typeof TODO_STATUS_NAMESPACE>['t']

/**
 * Props of the registered entry.
 *
 * The official contract owns `session`/`input` (the `InputZone` owner share)
 * and `t`. The three hooks the framework also delivers for this slot are
 * declared optional because this checkout's installed typings carry no
 * `ui-session` standard-props merge; a seat that is genuinely absent reads as
 * unknown instead of being guessed.
 */
export type TodoStatusDockProps = PropsRuntime<'conversation.input.dock'> &
  PropsLocale<typeof TODO_STATUS_NAMESPACE> & {
    /** Official per-key projection reader (`todos`, `subagentCatalog`). */
    useProjection?: UseProjection | undefined
    /** Official per-Session status snapshot. */
    useSessionStatus?: SessionStatusSeat | undefined
    /** Official Session list read-back, used only as the child-status fallback. */
    useSessions?: SessionListSeat | undefined
    /** Optional wiring seam retained for compatibility with older registrations. */
    readChildStatus?: ((childId: string) => boolean | undefined) | undefined
  }

/**
 * Stand-in seat used when the framework did not deliver one.
 *
 * Calling through a stable fallback keeps every seat call unconditional, so the
 * hook count of a mounted entry cannot vary between its renders: a registration
 * never changes which seats exist.
 */
const absentProjection = (() => undefined) as unknown as UseProjection
const absentStatusSeat = (() => undefined) as unknown as SessionStatusSeat
const absentListSeat = (() => undefined) as unknown as SessionListSeat

const identityStatus: Parameters<SessionStatusSeat>[0] = (snapshot) => snapshot
const identityList: Parameters<SessionListSeat>[0] = (snapshot) => snapshot

/** `已完成 N · 进行中（记录）N · 待处理 N`, omitting empty buckets. */
function progressText(t: TodoTranslate, counts: TodoCounts, running: boolean): string {
  const parts: string[] = []
  if (counts.completed > 0) parts.push(`${t('progressDone')} ${counts.completed}`)
  if (counts.inProgress > 0)
    parts.push(`${t(running ? 'progressActive' : 'statusUnfinished')} ${counts.inProgress}`)
  if (counts.pending > 0) parts.push(`${t('progressPending')} ${counts.pending}`)
  return parts.join(' · ')
}

/**
 * The dock entry.
 * @param props - official owner share plus the framework seats.
 * @returns the panel, or nothing while no todo is recorded.
 */
export function TodoStatusDock({
  session,
  useProjection,
  useSessionStatus,
  useSessions,
  readChildStatus,
  t,
}: TodoStatusDockProps) {
  const projection = useProjection ?? absentProjection
  const statusSeat = useSessionStatus ?? absentStatusSeat
  const listSeat = useSessions ?? absentListSeat
  const todos = projection('todos')
  const statuses = statusSeat(identityStatus)
  const list = listSeat(identityList)
  const [owner, setOwner] = useState(session?.sessionId)
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()
  // A different Session is a different panel: collapse state never carries over,
  // and a late value from the previous Session has nowhere to land because every
  // rendered value is read from this render's props.
  if (owner !== session?.sessionId) {
    setOwner(session?.sessionId)
    setCollapsed(true)
  }
  void statuses
  void list
  void readChildStatus
  const view = projectTodoPanel(todos, session?.running, {
    kind: 'none',
    total: 0,
    running: 0,
    unknown: 0,
  })
  if (view.rows.length === 0) return null
  const activityHint = [
    t(ACTIVITY_LABEL_KEY[view.activity]),
    view.showStoppedNote ? t('stoppedNote') : '',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <section
      className={css.root}
      data-testid="todo-panel"
      data-session-activity={view.activity}
      data-child-activity={view.children.kind}
      aria-label={t('title')}
    >
      <div className={css.body}>
        <button
          type="button"
          className={css.header}
          title={activityHint}
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span className={css.lead} aria-hidden="true">
            <IconChecklistOutlineRegular />
          </span>
          <span className={css.title}>{t('title')}</span>
          <span className={css.progress}>
            {progressText(t, view.counts, view.activity === 'running')}
          </span>
          <span className={css.chevron} aria-hidden="true">
            {collapsed ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
          </span>
        </button>
        {collapsed ? null : (
          <ul className={css.list} id={listId}>
            {view.rows.map((row) => (
              <li
                key={row.key}
                className={css.item}
                data-status={row.status}
                data-display={row.display}
              >
                <span className={css.glyph} role="img" aria-label={t(row.labelKey)}>
                  <StateDot state={row.dot} />
                </span>
                <span className={css.state}>{t(row.labelKey)}</span>
                <span className={css.content} title={row.content}>
                  {row.content}
                </span>
              </li>
            ))}
          </ul>
        )}
        {view.showStoppedNote ? <div className={css.note}>{t('stoppedNote')}</div> : null}
      </div>
    </section>
  )
}
