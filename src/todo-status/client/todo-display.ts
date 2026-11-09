/**
 * Pure presentation of the official `todos` projection. No React, no IO.
 *
 * Three sources stay strictly apart:
 * 1. the `todos` projection — the model's recorded whole-list snapshot. Its
 *    `in_progress` is a declaration in the log, never proof of live execution;
 * 2. the owning Session's run state (`SessionSnapshot.running`) — the only
 *    statement about the Session printed here;
 * 3. the direct-child `subagentCatalog` plus the framework's child status
 *    read — reported on its own line and never mapped onto, or allowed to
 *    complete, any recorded item.
 *
 * @module todo-status/client/todo-display
 */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { TodoLocaleKey } from './locales.ts'

/** Recorded activity of the owning Session. `unknown` is not `stopped`. */
export type SessionActivity = 'running' | 'stopped' | 'unknown'

/** Recorded status of one todo item, verbatim from the projection. */
export type RecordedTodoStatus = TodoItem['status']

/**
 * Display kind of one item. It refines the recorded status for presentation only.
 *
 * `recorded-in-progress` is still only a recorded declaration; `unfinished`
 * and `unfinished-unknown` are the static forms used once the Session is no
 * longer running, so a stopped Session can never show an endless spinner.
 */
export type TodoDisplayState =
  'done' | 'pending' | 'recorded-in-progress' | 'unfinished' | 'unfinished-unknown'

/** One rendered todo row. */
export interface TodoRowView {
  /** Stable React key; the recorded list is replaced wholesale and may repeat text. */
  readonly key: string
  /** Recorded text, unmodified. */
  readonly content: string
  /** Recorded status, unmodified. */
  readonly status: RecordedTodoStatus
  /** How this row is drawn now. */
  readonly display: TodoDisplayState
  /** Dot drawn for this row; `ongoing` only while the Session is genuinely running. */
  readonly dot: StateDotState
  /** Label key shown for this row. */
  readonly labelKey: TodoLocaleKey
  /** Whether the recorded status is not `completed`. */
  readonly unfinished: boolean
}

/** Counts over the recorded statuses, never over the display kinds. */
export interface TodoCounts {
  readonly completed: number
  readonly inProgress: number
  readonly pending: number
}

/** How the direct children of this Session were observed. */
export type ChildActivityKind = 'none' | 'running' | 'idle' | 'unknown' | 'unavailable'

/** Panel-level child observation, kept independent of every todo row. */
export interface ChildActivityView {
  readonly kind: ChildActivityKind
  /** Direct children in the parent catalogue; `0` when the catalogue was unreadable. */
  readonly total: number
  /** Children whose status read `running`. */
  readonly running: number
  /** Children whose status could not be read at all. */
  readonly unknown: number
}

/** Read one child's run state: `true`, `false`, or `undefined` when unknown. */
export type ChildActivityReader = (childId: string) => boolean | undefined

/** Complete panel view derived from the public projections. */
export interface TodoPanelView {
  readonly rows: readonly TodoRowView[]
  readonly counts: TodoCounts
  readonly activity: SessionActivity
  /** Rows whose recorded status is not `completed`. */
  readonly unfinished: number
  /** Whether the stopped note applies: the Session is known not running and work remains. */
  readonly showStoppedNote: boolean
  readonly children: ChildActivityView
}

/**
 * Classify the owning Session's run state.
 * @param running - official `SessionSnapshot.running`, or `undefined` when unread.
 * @returns the activity; anything but a known boolean is `unknown`.
 */
export function sessionActivity(running: boolean | undefined): SessionActivity {
  if (running === true) return 'running'
  if (running === false) return 'stopped'
  return 'unknown'
}

/**
 * Pick the dot, label, and display kind of one recorded status.
 *
 * Only a recorded `completed` may ever render `done`; stopping, cancelling, or
 * a turn ending cannot turn any row into it.
 * @param status - recorded status from the projection.
 * @param activity - classified run state of the owning Session.
 * @returns the presentation of that status.
 */
export function todoRowState(
  status: RecordedTodoStatus,
  activity: SessionActivity,
): { display: TodoDisplayState; dot: StateDotState; labelKey: TodoLocaleKey; unfinished: boolean } {
  switch (status) {
    case 'completed':
      return { display: 'done', dot: 'done', labelKey: 'statusCompleted', unfinished: false }
    case 'pending':
      return { display: 'pending', dot: 'idle', labelKey: 'statusPending', unfinished: true }
    case 'in_progress':
      if (activity === 'running')
        return {
          display: 'recorded-in-progress',
          dot: 'ongoing',
          labelKey: 'statusInProgress',
          unfinished: true,
        }
      if (activity === 'stopped')
        return {
          display: 'unfinished',
          dot: 'warning',
          labelKey: 'statusUnfinished',
          unfinished: true,
        }
      return {
        display: 'unfinished-unknown',
        dot: 'warning',
        labelKey: 'statusUnfinishedUnknown',
        unfinished: true,
      }
  }
}

/**
 * Reduce the direct-child catalogue with the framework's status read.
 *
 * A child whose status cannot be read stays `unknown`; it is never reported as
 * stopped, and an unreadable catalogue is `unavailable`, never "no children".
 * @param catalog - `subagentCatalog` value, or `undefined` when unread.
 * @param read - per-child status read, or `undefined` when no seat exists.
 * @returns the panel-level child observation.
 */
export function childActivity(
  catalog: readonly SubagentCatalogEntry[] | undefined,
  read: ChildActivityReader | undefined,
): ChildActivityView {
  if (catalog === undefined) return { kind: 'unavailable', total: 0, running: 0, unknown: 0 }
  if (catalog.length === 0) return { kind: 'none', total: 0, running: 0, unknown: 0 }
  let running = 0
  let unknown = 0
  for (const child of catalog) {
    const status = read?.(child.id)
    if (status === true) running += 1
    else if (status !== false) unknown += 1
  }
  const total = catalog.length
  if (running > 0) return { kind: 'running', total, running, unknown }
  return { kind: unknown > 0 ? 'unknown' : 'idle', total, running, unknown }
}

/**
 * Project the whole panel from public values only.
 *
 * The input array and its items are never written to, reordered, or filtered.
 * @param todos - `todos` projection value (`null` before the first write).
 * @param running - `SessionSnapshot.running`, or `undefined` when unread.
 * @param children - child observation from {@link childActivity}.
 * @returns the complete panel view; `rows` is empty when nothing is recorded.
 */
export function projectTodoPanel(
  todos: readonly TodoItem[] | null | undefined,
  running: boolean | undefined,
  children: ChildActivityView,
): TodoPanelView {
  const activity = sessionActivity(running)
  const rows: TodoRowView[] = (todos ?? []).map((item, index) => ({
    key: `${index}:${item.content}`,
    content: item.content,
    status: item.status,
    ...todoRowState(item.status, activity),
  }))
  let completed = 0
  let inProgress = 0
  let pending = 0
  for (const row of rows) {
    if (row.status === 'completed') completed += 1
    else if (row.status === 'in_progress') inProgress += 1
    else pending += 1
  }
  const counts: TodoCounts = { completed, inProgress, pending }
  const unfinished = rows.filter((row) => row.unfinished).length
  return {
    rows,
    counts,
    activity,
    unfinished,
    showStoppedNote: activity === 'stopped' && unfinished > 0,
    children,
  }
}

/** Sentence key describing the owning Session's activity. */
export const ACTIVITY_LABEL_KEY: Record<SessionActivity, TodoLocaleKey> = {
  running: 'activityRunning',
  stopped: 'activityStopped',
  unknown: 'activityUnknown',
}

/** Sentence key describing the direct children, or `undefined` when nothing is shown. */
export function childActivityLabelKey(kind: ChildActivityKind): TodoLocaleKey | undefined {
  switch (kind) {
    case 'none':
      return undefined
    case 'running':
      return 'childRunning'
    case 'idle':
      return 'childIdle'
    case 'unknown':
      return 'childUnknown'
    case 'unavailable':
      return 'childUnavailable'
  }
}
