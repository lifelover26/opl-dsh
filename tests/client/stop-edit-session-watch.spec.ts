import { expect, it, vi } from 'vitest'
import { watchStopEditSession } from '../../src/execution/client/stop-edit-session-watch.ts'
import type {
  SessionEventChange,
  SessionEventLikeEntry,
  SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'

it('refreshes each live run transition and stops observing after release', () => {
  const state = { running: false, blank: true, openState: 'open', other: 0 }
  const subscribers = new Set<() => void>()
  const session = {
    getSnapshot: () => state,
    subscribe: (callback: () => void) => {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
    update: (change: (value: typeof state) => void) => {
      change(state)
      subscribers.forEach((callback) => callback())
    },
  }
  const listener = vi.fn()
  const off = watchStopEditSession(session, listener)
  session.update((s) => {
    s.other++
  })
  expect(listener).not.toHaveBeenCalled()
  session.update((s) => {
    s.running = true
  })
  session.update((s) => {
    s.blank = false
  })
  session.update((s) => {
    s.running = false
  })
  expect(listener).toHaveBeenCalledTimes(3)
  off()
  session.update((s) => {
    s.running = true
  })
  expect(listener).toHaveBeenCalledTimes(3)
})

it('observes editable history arrivals and replacements without requests for streaming deltas', () => {
  let window: SessionEventWindow = {
    entries: [],
    hasMore: false,
    revision: 0,
    change: { kind: 'replace', entries: [] },
  }
  const subscribers = new Set<() => void>()
  const events = {
    getSnapshot: () => window,
    subscribe: (callback: () => void) => {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
  }
  const update = (change: SessionEventChange) => {
    window = { ...window, revision: window.revision + 1, change }
    for (const callback of subscribers) callback()
  }
  const entry = (type: string, transient = false) =>
    ({
      type: transient ? 'transient' : 'event',
      event: { type, seq: 1 },
    }) as SessionEventLikeEntry
  const session = {
    getSnapshot: () => ({ running: false, blank: false, openState: 'open' }),
    subscribe: () => () => {},
  }
  const listener = vi.fn()
  const off = watchStopEditSession(session, listener, events)
  for (let index = 0; index < 30; index++)
    update({ kind: 'append', entries: [entry('assistant/live-chunk', true)] })
  update({ kind: 'append', entries: [entry('assistant/message'), entry('tool/result')] })
  update({ kind: 'settle-assistant', attemptId: 'attempt' as never })
  expect(listener).not.toHaveBeenCalled()
  for (const type of ['user/message', 'system/message', 'turn/end'])
    update({ kind: 'append', entries: [entry(type)] })
  expect(listener).toHaveBeenCalledTimes(3)
  update({ kind: 'replace', entries: [entry('user/message')] })
  update({ kind: 'prepend', entries: [entry('user/message')] })
  expect(listener).toHaveBeenCalledTimes(5)
  for (const callback of subscribers) callback()
  expect(listener).toHaveBeenCalledTimes(5)
  off()
  expect(subscribers.size).toBe(0)
  update({ kind: 'replace', entries: [] })
  expect(listener).toHaveBeenCalledTimes(5)
})
