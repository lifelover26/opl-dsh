import { createTestDom } from './dom.ts'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'
import { MessageEditControl } from '../../src/execution/client/MessageEditControl.tsx'
import { MessageEditSession } from '../../src/execution/client/message-edit-session.ts'
import type {
  MessageEditSend,
  MessageEditState,
} from '../../src/execution/contracts/message-edit.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCloseOutlineRegular: () => null,
  Tooltip: ({ children, label }: { children: ReactNode; label: string }) =>
    createElement('span', { title: label }, children),
}))

type ShimNode = {
  nodeType: number
  childNodes?: ShimNode[]
  parentNode?: ShimNode | null
  tagName?: string
  nodeName?: string
  textContent?: string | null
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
      defaultPrevented: false,
      timeStamp: 0,
      eventPhase: 2,
      preventDefault() {
        event.defaultPrevented = true
      },
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
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.useRealTimers()
})

function buttons(scope: ShimNode): ShimNode[] {
  return [
    ...(scope.nodeName === 'BUTTON' ? [scope] : []),
    ...(scope.childNodes ?? []).flatMap(buttons),
  ]
}

it('keeps unconfirmed edit recovery out of the composer and never submits it on load', async () => {
  const recovery: MessageEditSend = {
    prompt: {
      sessionId: 'failed-prepare' as MessageEditSend['prompt']['sessionId'],
      requestId: 'original-request' as MessageEditSend['prompt']['requestId'],
      mode: 'queue',
      content: [{ type: 'text', text: 'original edited text' }],
    },
    targetSeq: 3,
    head: 8,
  }
  const call = vi.fn(async (method: string) =>
    method === 'message-edit-state'
      ? {
          sessionId: 'failed-prepare',
          supported: true,
          busy: false,
          pending: true,
          choices: [],
          head: 12,
          recovery,
        }
      : { accepted: true },
  )
  const session = new MessageEditSession('failed-prepare', call as ExecutionCall)
  const onActiveChange = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(MessageEditControl, {
        session,
        inputActions: { setDraft: vi.fn() },
        onActiveChange,
      }),
    ),
  )
  expect(container.textContent).toBe('')
  expect(buttons(container)).toHaveLength(0)
  expect(onActiveChange).not.toHaveBeenCalledWith(true)
  expect(call).toHaveBeenCalledExactlyOnceWith('message-edit-state', {
    sessionId: 'failed-prepare',
  })
})

it('selects one message in shared state without opening a second message list', async () => {
  const call = vi.fn(async (method: string) =>
    method === 'message-edit-state'
      ? {
          sessionId: 'one-message',
          supported: true,
          busy: false,
          pending: false,
          head: 4,
          choices: [{ seq: 3, text: '可编辑消息' }],
        }
      : { accepted: true },
  )
  const session = new MessageEditSession('one-message', call as ExecutionCall)
  await session.load()
  expect(await session.select(3, '')).toBe(true)
  expect(session.getSnapshot().selection).toEqual({
    seq: 3,
    head: 4,
    previousDraft: '',
  })
  expect(await session.select(3, '已有草稿')).toBe(false)
  expect(session.getSnapshot().error).toContain('草稿')
})

it('keeps only cancellation in the composer after selecting a message', async () => {
  const session = new MessageEditSession(
    'cancel-selection',
    vi.fn().mockResolvedValue(availableState('cancel-selection')) as ExecutionCall,
  )
  await session.load()
  await session.select(3, '')
  const setDraft = vi.fn()
  const onActiveChange = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(MessageEditControl, {
        session,
        inputActions: { setDraft },
        onActiveChange,
      }),
    ),
  )
  expect(buttons(container)).toHaveLength(1)
  expect(buttons(container)[0]?.getAttribute?.('aria-label')).toBe('取消编辑')
  expect(onActiveChange).toHaveBeenCalledWith(true)
  await act(async () => buttons(container)[0]!.click!())
  expect(session.getSnapshot().selection).toBeUndefined()
  expect(setDraft).toHaveBeenCalledExactlyOnceWith('')
  expect(buttons(container)).toHaveLength(0)
  expect(onActiveChange).toHaveBeenLastCalledWith(false)
})

it('hides recovery during a running edit and clears a stale read after a session change', async () => {
  const recovery = {
    prompt: { sessionId: 'race', requestId: 'edit' },
    targetSeq: 1,
    head: 2,
  } as MessageEditSend
  const state = {
    sessionId: 'race',
    supported: true,
    busy: true,
    pending: true,
    head: 3,
    choices: [],
    recovery,
  }
  let resolveRead!: (value: typeof state) => void
  const call = vi
    .fn()
    .mockResolvedValueOnce(state)
    .mockImplementationOnce(
      () =>
        new Promise<typeof state>((resolve) => {
          resolveRead = resolve
        }),
    )
    .mockResolvedValueOnce({ ...state, busy: false, pending: false, recovery: undefined })
  const session = new MessageEditSession('race', call as ExecutionCall)
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(MessageEditControl, { session, inputActions: { setDraft: vi.fn() } }),
    ),
  )
  expect(container.textContent).not.toContain('重试未确认的编辑')
  const seen: unknown[] = []
  session.subscribe(() => seen.push(session.getSnapshot().state?.recovery))
  await act(async () => {
    const first = session.load()
    const changed = session.load()
    resolveRead({ ...state, busy: false })
    await Promise.all([first, changed])
  })
  expect(call).toHaveBeenCalledTimes(3)
  expect(seen).not.toContain(recovery)
  expect(session.getSnapshot().state?.pending).toBe(false)
  expect(container.textContent).not.toContain('重试未确认的编辑')
})

function availableState(sessionId = 'retry-session'): MessageEditState {
  return {
    sessionId,
    supported: true,
    busy: false,
    pending: false,
    head: 5,
    choices: [{ seq: 3, text: '编辑原文' }],
  }
}

it('silently retries a failed history read without adding a composer entry or changing the draft', async () => {
  vi.useFakeTimers()
  const call = vi
    .fn()
    .mockRejectedValueOnce(Error('private transport failure'))
    .mockResolvedValueOnce(availableState())
  const session = new MessageEditSession('retry-session', call as ExecutionCall)
  const onActiveChange = vi.fn()
  const setDraft = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(MessageEditControl, {
        session,
        inputActions: { setDraft },
        onActiveChange,
      }),
    ),
  )
  expect(container.textContent).toBe('')
  expect(buttons(container)).toHaveLength(0)
  expect(onActiveChange).not.toHaveBeenCalledWith(true)
  await act(async () => vi.advanceTimersByTimeAsync(300))
  expect(call).toHaveBeenCalledTimes(2)
  expect(container.textContent).toBe('')
  expect(setDraft).not.toHaveBeenCalled()
})

it('bounds automatic history retries and leaves further retries explicit', async () => {
  vi.useFakeTimers()
  const state: MessageEditState = {
    ...availableState(),
    choices: [],
    unavailable: { reason: 'history-busy', retryable: true },
  }
  const call = vi.fn().mockResolvedValue(state)
  const session = new MessageEditSession(state.sessionId, call as ExecutionCall)
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(MessageEditControl, { session, inputActions: { setDraft: vi.fn() } }),
    ),
  )
  expect(call).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTimeAsync(300))
  expect(call).toHaveBeenCalledTimes(2)
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(call).toHaveBeenCalledTimes(3)
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(call).toHaveBeenCalledTimes(3)
  expect(buttons(container)).toHaveLength(0)
  expect(container.textContent).toBe('')
  await act(async () => session.retry())
  expect(call).toHaveBeenCalledTimes(4)
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(call).toHaveBeenCalledTimes(4)
  expect(call.mock.calls.every(([method]) => method === 'message-edit-state')).toBe(true)
})

it.each(['mapping-unavailable', 'model-unavailable'] as const)(
  'does not retry %s automatically or reserve the model picker width',
  async (reason) => {
    vi.useFakeTimers()
    const call = vi.fn().mockResolvedValue({
      ...availableState(),
      choices: [],
      unavailable: { reason, retryable: false },
    })
    const session = new MessageEditSession('retry-session', call as ExecutionCall)
    const onActiveChange = vi.fn()
    const container = dom.container()
    root = createRoot(container as unknown as HTMLElement)
    await act(async () =>
      root.render(
        createElement(MessageEditControl, {
          session,
          inputActions: { setDraft: vi.fn() },
          onActiveChange,
        }),
      ),
    )
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(call).toHaveBeenCalledTimes(1)
    expect(buttons(container)).toHaveLength(0)
    expect(container.textContent).toBe('')
    expect(onActiveChange).not.toHaveBeenCalledWith(true)
  },
)

it('releases the old session subscription and prevents an old retry from rearming after switching', async () => {
  vi.useFakeTimers()
  const unavailable: MessageEditState = {
    ...availableState('old-session'),
    choices: [],
    unavailable: { reason: 'history-unavailable', retryable: true },
  }
  let resolveOld!: (state: MessageEditState) => void
  const oldCall = vi
    .fn()
    .mockResolvedValueOnce(unavailable)
    .mockImplementationOnce(
      () =>
        new Promise<MessageEditState>((resolve) => {
          resolveOld = resolve
        }),
    )
  const oldSession = new MessageEditSession('old-session', oldCall as ExecutionCall)
  const nextCall = vi.fn().mockResolvedValue(availableState('next-session'))
  const nextSession = new MessageEditSession('next-session', nextCall as ExecutionCall)
  const offOld = vi.fn()
  const offNext = vi.fn()
  const subscribeSession = vi.fn((id: string) => (id === 'old-session' ? offOld : offNext))
  const setDraft = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  const render = (session: MessageEditSession) =>
    root.render(
      createElement(MessageEditControl, { session, inputActions: { setDraft }, subscribeSession }),
    )
  await act(async () => render(oldSession))
  await act(async () => vi.advanceTimersByTimeAsync(300))
  expect(oldCall).toHaveBeenCalledTimes(2)
  await act(async () => render(nextSession))
  expect(offOld).toHaveBeenCalledTimes(1)
  await act(async () => resolveOld(unavailable))
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(oldCall).toHaveBeenCalledTimes(2)
  expect(nextCall).toHaveBeenCalledTimes(1)
  expect(container.textContent).toBe('')
  expect(setDraft).not.toHaveBeenCalled()
  await act(async () => root.unmount())
  expect(offNext).toHaveBeenCalledTimes(1)
})

it('cancels a pending history retry on unmount', async () => {
  vi.useFakeTimers()
  const call = vi.fn().mockResolvedValue({
    ...availableState(),
    choices: [],
    unavailable: { reason: 'history-unavailable', retryable: true },
  })
  const session = new MessageEditSession('retry-session', call as ExecutionCall)
  root = createRoot(dom.container() as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(MessageEditControl, { session, inputActions: { setDraft: vi.fn() } }),
    ),
  )
  await act(async () => root.unmount())
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(call).toHaveBeenCalledTimes(1)
})
