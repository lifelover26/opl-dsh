import { createTestDom } from './dom.ts'
import { act, createElement, type ComponentType, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'
import { MessageEditSession } from '../../src/execution/client/message-edit-session.ts'
import { MessageEditAction } from '../../src/execution/client/MessageEditAction.tsx'
import type { MessageEditState } from '../../src/execution/contracts/message-edit.ts'
import {
  MessageEditUserRow,
  installMessageEditUserRows,
  type MessageEditUserRowProps,
} from '../../src/execution/client/MessageEditUserRow.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCopyOutlineRegular: () => null,
  IconEditOutlineRegular: () => null,
  Tooltip: ({ children }: { children: unknown }) => children,
}))

type ShimNode = {
  nodeName?: string
  childNodes?: ShimNode[]
  parentNode?: ShimNode | null
  getAttribute?(name: string): string | null
  click?(): boolean
}

function enableClick(dom: { document: { createElement(name: string): object } }) {
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
  const dispatch = (type: string, target: object) => {
    const event = {
      type,
      target,
      bubbles: true,
      cancelable: true,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    }
    let node = target as { parentNode?: ShimNode | null } | null
    while (node) {
      for (const listener of listeners.get(node)?.get(type) ?? []) listener(event)
      node = node.parentNode
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
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
})
let root: Root
const installations: (() => void)[] = []
afterEach(async () => {
  await act(async () => root?.unmount())
  for (const dispose of installations.splice(0)) dispose()
})

type ResidentUserRowProps = Omit<MessageEditUserRowProps, 'edit'>

function userRows() {
  const core = new SlotCore()
  core.register(
    {
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    },
    () => null,
  )
  const original = () => null
  const inject = () => ({ officialSeat: 'retained' })
  const register = (component = original) =>
    core.register(
      {
        name: 'conversation.chat.node',
        key: 'user',
        locale: 'chat',
        children: { 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } },
        inject,
      },
      component,
    )
  const install = (
    messageEditFor: (id: string) => MessageEditSession = vi.fn(
      (id: string) => new MessageEditSession(id, vi.fn()),
    ),
  ) => {
    const dispose = installMessageEditUserRows(core, messageEditFor)
    installations.push(dispose)
    return dispose
  }
  const entry = () =>
    core
      .entries('conversation.chat.node')
      .find((candidate) => candidate.children?.['conversation.chat.user.before'] !== undefined)!
  return { core, original, inject, register, install, entry }
}

function buttons(scope: ShimNode): ShimNode[] {
  return [
    ...(scope.nodeName === 'BUTTON' ? [scope] : []),
    ...(scope.childNodes ?? []).flatMap(buttons),
  ]
}

it('renders edit beside copy and fills the exact selected message', async () => {
  const call = vi.fn(async (method: string) =>
    method === 'message-edit-state'
      ? {
          sessionId: 'row-session',
          supported: true,
          busy: false,
          pending: false,
          head: 9,
          choices: [{ seq: 3, text: '第一条可编辑消息' }],
        }
      : { accepted: true },
  )
  const session = new MessageEditSession('row-session', call as ExecutionCall)
  await session.load()
  const setDraft = vi.fn()
  const renderSlotChain = vi.fn((_name, props) =>
    createElement('span', null, `source:${props.source.kind}`),
  )
  const rows = userRows()
  rows.register()
  const messageEditFor = vi.fn(() => session)
  rows.install(messageEditFor)
  const Resident = rows.entry().component as ComponentType<ResidentUserRowProps>
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(Resident, {
        sessionId: 'row-session',
        node: {
          kind: 'user',
          data: {
            kind: 'user',
            seq: 3,
            time: Date.now(),
            content: [{ type: 'text', text: '第一条可编辑消息' }],
            source: { kind: 'user' },
          },
        },
        loadImage: vi.fn(),
        renderSlotChain,
        renderFactorySlot: vi.fn((_name, props) => createElement('span', null, props.content.text)),
        useInput: ((selector: (state: { draft: string }) => unknown) =>
          selector({ draft: '' })) as ChatNodeViewProps<'user'>['useInput'],
        inputActions: { setDraft },
        t: (key: string) =>
          ({
            copy: '复制',
            copied: '已复制',
            'clock.md': '{m}月{d}日',
            'clock.ymd': '{y}年{m}月{d}日',
          })[key] ?? key,
      } as unknown as ResidentUserRowProps),
    ),
  )
  const actions = buttons(container)
  expect(actions.map((button) => button.getAttribute?.('aria-label'))).toEqual(['复制', '编辑消息'])
  expect(container.textContent).toContain('第一条可编辑消息')
  expect(container.textContent).toContain('source:user')
  expect(renderSlotChain).toHaveBeenCalledWith(
    'conversation.chat.user.before',
    { source: { kind: 'user' }, kind: 'user' },
    { fallback: null },
  )
  expect(container.textContent).not.toContain('取消编辑')
  expect(messageEditFor).toHaveBeenCalledWith('row-session')
  await act(async () => actions[1]!.click!())
  expect(setDraft).toHaveBeenCalledWith('第一条可编辑消息')
})

it.each(['before', 'after'] as const)(
  'retains the official user row and source chain when the owner arrives %s installation',
  async (arrival) => {
    const rows = userRows()
    if (arrival === 'before') rows.register()
    const dispose = rows.install()
    if (arrival === 'after') rows.register()
    const owner = rows.entry()
    const options = owner.options
    const children = owner.children
    const sourceSpec = rows.core.spec('conversation.chat.user.before')
    const decoration = () => null
    rows.core.register(
      { name: 'conversation.chat.user.before', select: ({ source }) => source },
      decoration,
    )
    const sourceEntries = rows.core.entries('conversation.chat.user.before')
    await Promise.resolve()
    expect(rows.core.entries('conversation.chat.node')).toEqual([owner])
    expect(rows.core.isLive(owner)).toBe(true)
    expect(owner.options).toBe(options)
    expect(owner.children).toBe(children)
    expect(owner.inject).toBe(rows.inject)
    expect(owner.component).not.toBe(rows.original)
    expect(rows.core.spec('conversation.chat.user.before')).toBe(sourceSpec)
    expect(rows.core.entries('conversation.chat.user.before')).toBe(sourceEntries)
    expect(sourceEntries[0]?.component).toBe(decoration)
    dispose()
    expect(owner.component).toBe(rows.original)
    expect(rows.core.entries('conversation.chat.user.before')).toBe(sourceEntries)
  },
)

it('decorates only the user entry that owns the message-source chain', () => {
  const rows = userRows()
  const shadow = () => null
  rows.core.register({ name: 'conversation.chat.node', key: 'user', priority: -1 }, shadow)
  rows.register()
  rows.install()
  expect(rows.core.entries('conversation.chat.node')[0]?.component).toBe(shadow)
  expect(rows.entry().component).not.toBe(rows.original)
})

it('leaves a source-chain owner for another node kind unchanged', () => {
  const rows = userRows()
  rows.core.register(
    {
      name: 'conversation.chat.node',
      key: 'steering',
      children: { 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } },
    },
    rows.original,
  )
  rows.install()
  expect(rows.entry().component).toBe(rows.original)
})

it('resolves edit state from each rendered Session and retains the authorized source renderer', () => {
  const rows = userRows()
  rows.register()
  const first = new MessageEditSession('first-session', vi.fn())
  const second = new MessageEditSession('second-session', vi.fn())
  const messageEditFor = vi.fn((id: string) => (id === 'first-session' ? first : second))
  rows.install(messageEditFor)
  const render = rows.entry().component as (
    props: ResidentUserRowProps,
  ) => ReactElement<MessageEditUserRowProps>
  const sourceRenderer = vi.fn()
  for (const [sessionId, edit] of [
    ['first-session', first],
    ['second-session', second],
  ] as const) {
    const element = render({
      sessionId,
      renderSlotChain: sourceRenderer,
    } as unknown as ResidentUserRowProps)
    expect(element.type).toBe(MessageEditUserRow)
    expect(element.props.sessionId).toBe(sessionId)
    expect(element.props.edit).toBe(edit)
    expect(element.props.renderSlotChain).toBe(sourceRenderer)
  }
  expect(messageEditFor.mock.calls).toEqual([['first-session'], ['second-session']])
})

it('restores a retired owner and decorates its replacement', async () => {
  const rows = userRows()
  const unregister = rows.register()
  const first = rows.entry()
  const dispose = rows.install()
  unregister()
  await Promise.resolve()
  expect(first.component).toBe(rows.original)
  const replacement = () => null
  rows.register(replacement)
  const second = rows.entry()
  await Promise.resolve()
  expect(second.component).not.toBe(replacement)
  expect(first.component).toBe(rows.original)
  dispose()
  expect(second.component).toBe(replacement)
})

it('preserves later component takeovers during owner replacement and disposal', async () => {
  const rows = userRows()
  const unregister = rows.register()
  const first = rows.entry()
  const dispose = rows.install()
  const firstTakeover = () => null
  first.component = firstTakeover
  unregister()
  rows.register()
  await Promise.resolve()
  expect(first.component).toBe(firstTakeover)
  const second = rows.entry()
  const secondTakeover = () => null
  second.component = secondTakeover
  dispose()
  expect(first.component).toBe(firstTakeover)
  expect(second.component).toBe(secondTakeover)
})

it('stops waiting for an owner after disposal', async () => {
  const rows = userRows()
  const dispose = rows.install()
  dispose()
  rows.register()
  await Promise.resolve()
  expect(rows.entry().component).toBe(rows.original)
})

function actionState(sessionId = 'action-session'): MessageEditState {
  return {
    sessionId,
    supported: true,
    busy: false,
    pending: false,
    head: 9,
    choices: [{ seq: 3, text: '消息原文' }],
  }
}

it('keeps a supported edit action reachable while initial history is unavailable and retries only the read', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({
      ...actionState(),
      choices: [],
      unavailable: { reason: 'history-unavailable', retryable: true },
    })
    .mockResolvedValueOnce(actionState())
  const session = new MessageEditSession('action-session', call as ExecutionCall)
  await session.load()
  const onDraft = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(createElement(MessageEditAction, { session, seq: 3, draft: '', onDraft })),
  )
  expect(buttons(container).map((button) => button.getAttribute?.('aria-label'))).toEqual([
    '重试编辑',
  ])
  await act(async () => buttons(container)[0]!.click!())
  expect(call).toHaveBeenCalledTimes(2)
  expect(call).toHaveBeenLastCalledWith('message-edit-state', { sessionId: 'action-session' })
  expect(onDraft).not.toHaveBeenCalled()
  expect(session.getSnapshot().selection).toBeUndefined()
  expect(buttons(container)[0]?.getAttribute?.('aria-label')).toBe('编辑消息')
})

it.each([
  { supported: false, choices: [] },
  { supported: true, choices: [] },
])('omits an action without supported editable history: %j', async (fields) => {
  const call = vi.fn().mockResolvedValue({ ...actionState(), ...fields })
  const session = new MessageEditSession('action-session', call as ExecutionCall)
  await session.load()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(createElement(MessageEditAction, { session, seq: 3, draft: '', onDraft: vi.fn() })),
  )
  expect(buttons(container)).toHaveLength(0)
})

it('retains a known row action and selected draft during a temporary empty history result', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce(actionState())
    .mockResolvedValueOnce({
      ...actionState(),
      choices: [],
      unavailable: { reason: 'mapping-unavailable', retryable: false },
    })
  const session = new MessageEditSession('action-session', call as ExecutionCall)
  await session.load()
  await session.select(3, '')
  const selected = session.getSnapshot().selection
  const onDraft = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(createElement(MessageEditAction, { session, seq: 3, draft: '编辑草稿', onDraft })),
  )
  await act(async () => session.load())
  const action = buttons(container)[0]!
  expect(action.getAttribute?.('aria-label')).toBe('编辑消息')
  expect(action.getAttribute?.('aria-disabled')).toBe('true')
  await act(async () => action.click!())
  expect(call).toHaveBeenCalledTimes(2)
  expect(session.getSnapshot().selection).toBe(selected)
  expect(onDraft).not.toHaveBeenCalled()
})

it('offers a read retry after transport failure when engine support was already observed', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({ ...actionState(), choices: [] })
    .mockRejectedValueOnce(Error('offline'))
  const session = new MessageEditSession('action-session', call as ExecutionCall)
  await session.load()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(createElement(MessageEditAction, { session, seq: 3, draft: '', onDraft: vi.fn() })),
  )
  expect(buttons(container)).toHaveLength(0)
  await act(async () => session.load())
  expect(buttons(container)[0]?.getAttribute?.('aria-label')).toBe('重试编辑')
  expect(session.getSnapshot().selection).toBeUndefined()
})

it.each(['session', 'draft', 'unmount'] as const)(
  'does not fill an old edit after a %s change while selection completes',
  async (change) => {
    const call = vi.fn().mockResolvedValue(actionState())
    const session = new MessageEditSession('action-session', call as ExecutionCall)
    await session.load()
    const nextCall = vi.fn().mockResolvedValue(actionState('next-session'))
    const nextSession = new MessageEditSession('next-session', nextCall as ExecutionCall)
    await nextSession.load()
    const onDraft = vi.fn()
    const container = dom.container()
    root = createRoot(container as unknown as HTMLElement)
    const render = (active: MessageEditSession, draft = '') =>
      root.render(createElement(MessageEditAction, { session: active, seq: 3, draft, onDraft }))
    await act(async () => render(session))
    const select = session.select.bind(session)
    vi.spyOn(session, 'select').mockImplementation((seq, draft) => {
      const result = select(seq, draft)
      flushSync(() => {
        if (change === 'unmount') root.unmount()
        else
          render(change === 'session' ? nextSession : session, change === 'draft' ? '新草稿' : '')
      })
      return result
    })
    await act(async () => buttons(container)[0]!.click!())
    expect(onDraft).not.toHaveBeenCalled()
    expect(session.getSnapshot().selection).toBeUndefined()
    expect(nextSession.getSnapshot().selection).toBeUndefined()
  },
)
