/**
 * Component tests for the read-only todo panel.
 *
 * Nothing here touches a real Host, Remote, model, or Session: the panel is
 * rendered with the same props the framework delivers, driven by local
 * projections. Coverage: the parent running → stopped transition, the recorded
 * statuses staying identical, independent child activity (running / idle /
 * unknown, never mapped onto an item), the empty projection and the new-turn
 * clear, a Session switch and a late value, no assistant-text extraction, and
 * the collapse / keyboard / aria contract.
 */
import './dom.ts'
import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import {
  TodoStatusDock,
  type TodoStatusDockProps,
} from '../../src/todo-status/client/TodoStatusDock.tsx'
import { zh } from '../../src/todo-status/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  // The published primitives package is not loadable from this offline install
  // (its `clsx` dependency is absent), so the atoms this panel uses are stood in
  // for with minimal React elements that keep the state the panel passes
  // observable instead of hiding it.
  StateDot: ({ state }: { state: string }) => React.createElement('span', { 'data-dot': state }),
  IconChecklistOutlineRegular: () => null,
  IconChevronUpOutlineRegular: () => null,
  IconChevronDownOutlineRegular: () => null,
}))

type ShimNode = {
  nodeType: number
  childNodes?: ShimNode[]
  parentNode?: ShimNode | null
  nodeName?: string
  textContent?: string | null
  width?: number
  getAttribute?(name: string): string | null
  click?(): boolean
}

/**
 * Give the shim a real bubbling `click`, so React's delegated listener runs the
 * component's own handler instead of the test reaching into it.
 */
function enableClick(dom: { document: { createElement(name: string): object } }): void {
  const proto = Object.getPrototypeOf(dom.document.createElement('div')) as Record<string, unknown>
  const listeners = new WeakMap<object, Map<string, Set<(event: unknown) => void>>>()
  proto['addEventListener'] = function (type: string, listener: (event: unknown) => void) {
    let byType = listeners.get(this as object)
    if (!byType) listeners.set(this as object, (byType = new Map()))
    const set = byType.get(type) ?? new Set()
    set.add(listener)
    byType.set(type, set)
  }
  proto['removeEventListener'] = function (type: string, listener: (event: unknown) => void) {
    listeners
      .get(this as object)
      ?.get(type)
      ?.delete(listener)
  }
  const dispatch = (type: string, target: object): boolean => {
    const event = {
      type,
      target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      timeStamp: 0,
      eventPhase: 2,
      preventDefault() {
        event.defaultPrevented = true
      },
      stopPropagation() {},
      stopImmediatePropagation() {},
    }
    let node = target as { parentNode?: ShimNode | null | undefined } | null
    while (node) {
      for (const listener of listeners.get(node)?.get(type) ?? []) listener(event)
      node = node.parentNode ?? null
    }
    return true
  }
  proto['dispatchEvent'] = function (type: string) {
    return dispatch(type, this)
  }
  proto['click'] = function () {
    return dispatch('click', this)
  }
}

const dom = createTestDom()
enableClick(dom)

const dictionary: Record<string, string> = zh
function translate(key: string, params?: Record<string, unknown>): string {
  const template = dictionary[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

interface Stub {
  sessionId?: string
  running?: boolean | undefined
  todos?: readonly TodoItem[] | null | undefined
  catalog?: readonly SubagentCatalogEntry[] | undefined
  statuses?: ReadonlyMap<string, { running?: boolean }>
  list?: Readonly<Record<string, { running?: boolean } | undefined>>
  readChildStatus?: (childId: string) => boolean | undefined
  /** Drop the projection seat entirely, as a build without it would. */
  withoutProjection?: boolean
  withoutSeats?: boolean
  /** Anything the panel must never read. */
  extra?: Record<string, unknown>
}

function child(id: string): SubagentCatalogEntry {
  return { id: id as SubagentCatalogEntry['id'], createdAt: 0, mode: 'one-shot' }
}

function todo(content: string, status: TodoItem['status']): TodoItem {
  return { content, status }
}

function props(stub: Stub): TodoStatusDockProps {
  const projection = ((key: string) =>
    key === 'todos' ? stub.todos : stub.catalog) as unknown as UseProjection
  const seat = (snapshot: unknown) => (select: (value: unknown) => unknown) => select(snapshot)
  return {
    session: { sessionId: stub.sessionId ?? 'session-a', running: stub.running },
    input: {},
    useProjection: stub.withoutProjection === true ? undefined : projection,
    useSessionStatus:
      stub.withoutSeats === true
        ? undefined
        : (seat(stub.statuses ?? new Map()) as never as TodoStatusDockProps['useSessionStatus']),
    useSessions:
      stub.withoutSeats === true
        ? undefined
        : (seat({ byId: stub.list ?? {} }) as never as TodoStatusDockProps['useSessions']),
    readChildStatus: stub.readChildStatus,
    t: translate as TodoStatusDockProps['t'],
    ...stub.extra,
  } as unknown as TodoStatusDockProps
}

let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
  await React.act(async () => root?.unmount())
  root = undefined
})

async function render(stub: Stub): Promise<ShimNode> {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  root = createRoot(container as unknown as HTMLElement)
  await React.act(async () => root!.render(React.createElement(TodoStatusDock, props(stub))))
  return container as unknown as ShimNode
}

async function rerender(stub: Stub): Promise<void> {
  await React.act(async () => root!.render(React.createElement(TodoStatusDock, props(stub))))
}

function walk(node: ShimNode, visit: (node: ShimNode) => void): void {
  visit(node)
  for (const child of node.childNodes ?? []) walk(child, visit)
}

function all(scope: ShimNode, attr: string): ShimNode[] {
  const found: ShimNode[] = []
  walk(scope, (node) => {
    if (node.getAttribute?.(attr) != null) found.push(node)
  })
  return found
}

function one(scope: ShimNode, attr: string): ShimNode {
  const found = all(scope, attr)
  expect(found, `exactly one node with ${attr}`).toHaveLength(1)
  return found[0]!
}

function text(scope: ShimNode): string {
  return scope.textContent ?? ''
}

function rows(scope: ShimNode): ShimNode[] {
  return all(scope, 'data-status')
}

function withRole(scope: ShimNode, name: string): ShimNode[] {
  return all(scope, 'data-role').filter((node) => node.getAttribute!('data-role') === name)
}

function role(scope: ShimNode, name: string): ShimNode {
  const found = withRole(scope, name)
  expect(found, `exactly one node with data-role=${name}`).toHaveLength(1)
  return found[0]!
}

function dots(scope: ShimNode): string[] {
  return all(scope, 'data-dot').map((node) => node.getAttribute!('data-dot') ?? '')
}

function headerButton(scope: ShimNode): ShimNode {
  const found: ShimNode[] = []
  walk(scope, (node) => {
    if (node.nodeName === 'BUTTON') found.push(node)
  })
  expect(found, 'the panel header is one button').toHaveLength(1)
  return found[0]!
}

async function toggle(scope: ShimNode): Promise<void> {
  await React.act(async () => headerButton(scope).click!())
}

describe('empty projections', () => {
  it('renders nothing before the first write, after a new turn clears it, and without the seat', async () => {
    for (const stub of [
      { todos: null },
      { todos: [] },
      { todos: undefined },
      { withoutProjection: true, todos: [todo('hidden', 'pending')] },
    ]) {
      const container = await render(stub)
      expect(all(container, 'data-testid')).toHaveLength(0)
      expect(text(container)).toBe('')
      await React.act(async () => root?.unmount())
      root = undefined
    }
  })

  it('empties the panel when the official projection clears on a new turn', async () => {
    const container = await render({
      todos: [todo('Write the panel', 'in_progress')],
      running: true,
    })
    await toggle(container)
    expect(text(container)).toContain('Write the panel')
    await rerender({ todos: null, running: true })
    expect(all(container, 'data-testid')).toHaveLength(0)
  })
})

describe('collapse, keyboard, and aria', () => {
  it('starts collapsed and toggles through its own button', async () => {
    const container = await render({ todos: [todo('Ship it', 'pending')], running: true })
    const button = headerButton(container)
    expect(button.getAttribute!('type')).toBe('button')
    expect(button.getAttribute!('aria-expanded')).toBe('false')
    const controls = button.getAttribute!('aria-controls')
    expect(controls).toBeTruthy()
    expect(rows(container)).toHaveLength(0)
    await toggle(container)
    expect(headerButton(container).getAttribute!('aria-expanded')).toBe('true')
    expect(rows(container)).toHaveLength(1)
    const list = one(container, 'id')
    expect(list.getAttribute!('id')).toBe(controls)
    expect(list.nodeName).toBe('UL')
    await toggle(container)
    expect(headerButton(container).getAttribute!('aria-expanded')).toBe('false')
    expect(rows(container)).toHaveLength(0)
  })

  it('gives the panel and every row an accessible name', async () => {
    const container = await render({
      todos: [todo('Write the panel', 'in_progress')],
      running: false,
    })
    expect(one(container, 'data-testid').getAttribute!('aria-label')).toBe(zh.title)
    await toggle(container)
    const glyph = all(container, 'role')[0]!
    expect(glyph.getAttribute!('role')).toBe('img')
    expect(glyph.getAttribute!('aria-label')).toBe(zh.statusUnfinished)
  })
})

describe('a stopped Session', () => {
  it('shows unfinished instead of an endless running indicator, and keeps the record', async () => {
    const todos = [
      todo('Read the log', 'completed'),
      todo('Write the panel', 'in_progress'),
      todo('Ship it', 'pending'),
    ]
    const container = await render({ todos, running: true })
    await toggle(container)
    let recorded = rows(container).map((row) => row.getAttribute!('data-status'))
    expect(recorded).toEqual(['completed', 'in_progress', 'pending'])
    expect(rows(container)[1]!.getAttribute!('data-display')).toBe('recorded-in-progress')
    expect(dots(container)).toEqual(['done', 'ongoing', 'idle'])

    await rerender({ todos, running: false })
    recorded = rows(container).map((row) => row.getAttribute!('data-status'))
    expect(recorded).toEqual(['completed', 'in_progress', 'pending'])
    const panel = one(container, 'data-testid')
    expect(panel.getAttribute!('data-session-activity')).toBe('stopped')
    expect(rows(container)[1]!.getAttribute!('data-display')).toBe('unfinished')
    expect(rows(container)[1]!.getAttribute!('data-status')).toBe('in_progress')
    // The stopped panel carries no endless rotation: the dot degrades to the
    // static warning state and `ongoing` disappears from the whole panel.
    expect(dots(container)).toEqual(['done', 'warning', 'idle'])
    expect(dots(container)).not.toContain('ongoing')
    // No row may claim the recorded in-progress state as live any more.
    expect(rows(container).map((row) => row.getAttribute!('data-display'))).not.toContain(
      'recorded-in-progress',
    )
    expect(headerButton(container).getAttribute!('title')).toContain(zh.activityStopped)
    expect(headerButton(container).getAttribute!('title')).toContain(zh.stoppedNote)
    expect(text(container)).toContain(zh.stoppedNote)
    // The recorded counts stay, so the header never rewrites the data.
    expect(text(container)).toContain(`${zh.progressDone} 1`)
    expect(text(container)).toContain(`${zh.statusUnfinished} 1`)
    expect(text(container)).toContain(`${zh.progressPending} 1`)
  })

  it('reports an unreadable Session state as unknown, not stopped', async () => {
    const container = await render({
      todos: [todo('Write the panel', 'in_progress')],
      running: undefined,
    })
    const panel = one(container, 'data-testid')
    expect(panel.getAttribute!('data-session-activity')).toBe('unknown')
    await toggle(container)
    expect(rows(container)[0]!.getAttribute!('data-display')).toBe('unfinished-unknown')
    expect(withRole(container, 'stopped-note')).toHaveLength(0)
  })
})

it('shows only the current session todo state when a child is live', async () => {
  const container = await render({
    todos: [todo('Current item', 'in_progress')],
    running: false,
    catalog: [child('kid')],
    statuses: new Map([['kid', { running: true }]]),
  })
  await toggle(container)
  expect(rows(container)[0]!.getAttribute!('data-status')).toBe('in_progress')
  expect(withRole(container, 'child-activity')).toHaveLength(0)
})

describe('Session switching and unread inputs', () => {
  it('does not carry the previous Session into the next one', async () => {
    const container = await render({
      sessionId: 'session-a',
      todos: [todo('Old work', 'in_progress')],
      running: true,
    })
    await toggle(container)
    expect(text(container)).toContain('Old work')
    await rerender({ sessionId: 'session-b', todos: [todo('New work', 'pending')], running: true })
    expect(text(container)).not.toContain('Old work')
    expect(headerButton(container).getAttribute!('aria-expanded')).toBe('false')
    expect(rows(container)).toHaveLength(0)
  })

  it('renders without the optional standard seats', async () => {
    const container = await render({
      todos: [todo('Write the panel', 'in_progress')],
      running: false,
      withoutSeats: true,
    })
    await toggle(container)
    expect(text(container)).toContain('Write the panel')
    expect(one(container, 'data-testid').getAttribute!('data-session-activity')).toBe('stopped')
    expect(one(container, 'data-testid').getAttribute!('data-child-activity')).toBe('none')
  })
})

describe('display only', () => {
  it('never reads assistant text or any other prop', async () => {
    const extra = {
      message: { blocks: [{ type: 'text', text: '1. [ ] invented from prose' }] },
      trajectory: [{ text: '- [ ] also invented' }],
      input: { draft: '- [ ] drafted checklist' },
    }
    const container = await render({
      todos: [todo('Recorded item', 'pending')],
      running: true,
      extra,
    })
    await toggle(container)
    expect(text(container)).toContain('Recorded item')
    expect(text(container)).not.toContain('invented')
    expect(text(container)).not.toContain('drafted checklist')
    expect(rows(container)).toHaveLength(1)
  })

  it('keeps long content on one line and keeps the full text addressable', async () => {
    const long = 'x'.repeat(400)
    const container = await render({ todos: [todo(long, 'pending')], running: true })
    await toggle(container)
    const content = all(container, 'title').find((node) => node.getAttribute!('title') === long)
    expect(content, 'the full recorded text stays reachable').toBeDefined()
  })

  it('calls no write, load, or cancellation surface it can see', async () => {
    const spies = {
      load: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
      interrupt: vi.fn(),
      write: vi.fn(),
      setDraft: vi.fn(),
      inputActions: { setDraft: vi.fn(), submit: vi.fn(), cancel: vi.fn() },
      actions: { load: vi.fn(), run: vi.fn() },
    }
    const container = await render({
      todos: [todo('Write the panel', 'in_progress')],
      running: false,
      catalog: [child('kid')],
      statuses: new Map(),
      extra: spies,
    })
    await toggle(container)
    expect(text(container)).toContain('Write the panel')
    for (const [name, spy] of Object.entries(spies)) {
      if (typeof spy !== 'function') continue
      expect(spy, `${name} must not be called just by rendering`).not.toHaveBeenCalled()
    }
    for (const group of [spies.inputActions, spies.actions]) {
      for (const spy of Object.values(group))
        expect(spy, 'no action of the visible seats may be called').not.toHaveBeenCalled()
    }
  })
})
