/** Cold edit-state recovery through the official Client Session runtime. */
import { createTestDom } from './dom.ts'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import * as cordis from '@deepseek-ai/cordis'
import * as gateway from '@deepseek-ai/dsh-api-gateway/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  SessionControlFrame,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { act, createElement, Fragment, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import * as execution from '../../src/execution/client/index.tsx'
import { MessageEditAction } from '../../src/execution/client/MessageEditAction.tsx'
import {
  MessageEditUserRow,
  type MessageEditUserRowProps,
} from '../../src/execution/client/MessageEditUserRow.tsx'
import {
  MessageEditControl,
  type MessageEditProps,
} from '../../src/execution/client/MessageEditControl.tsx'
import type { MessageEditState } from '../../src/execution/contracts/message-edit.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCloseOutlineRegular: () => null,
  IconEditOutlineRegular: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => children,
}))

type Controller = Pick<
  typeof import('@deepseek-ai/dsh-api-session-controller/client'),
  'apply' | 'inject'
>

// The published Client entry is a desktop ModuleLoader bundle, not a Node ESM entry.
// Load that exact public entry with real Cordis/Gateway and a synchronous snapshot store.
function officialController(): Controller {
  let controller!: Controller
  const dependencies: Record<string, unknown> = {
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-api-gateway/client': gateway,
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore: snapshotStore,
      notifySubscribers: (listeners: Iterable<() => void>) => {
        for (const listener of [...listeners]) listener()
      },
    },
  }
  const entry = createRequire(import.meta.url).resolve(
    '@deepseek-ai/dsh-api-session-controller/client',
  )
  new Function('window', readFileSync(entry, 'utf8'))({
    __ModuleLoader__: {
      load({ factory }: { factory: (require: (name: string) => unknown) => Controller }) {
        controller = factory((name) => {
          if (!(name in dependencies)) throw Error(`Unexpected official Client dependency: ${name}`)
          return dependencies[name]
        })
      },
    },
  })
  return controller
}

// The offline install omits Zustand/Immer. Session generation, history, and
// projection publication still come entirely from the official Client runtime.
function snapshotStore<T>(initial: T): SnapshotStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    update() {
      throw Error('Unexpected snapshot-store draft mutation')
    },
  }
}

function feed<T>() {
  const stream = new PassThrough({ objectMode: true })
  return {
    push(value: T) {
      stream.write(value)
    },
    async *follow(signal: AbortSignal): AsyncIterable<T> {
      const abort = () => stream.end()
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (signal.aborted) return
        for await (const value of stream) yield value as T
      } finally {
        signal.removeEventListener('abort', abort)
        stream.destroy()
      }
    },
  }
}

const sessionId = 'cold-pi-session' as SessionId
const otherSessionId = 'other-session' as SessionId
const dom = createTestDom()
const contexts: cordis.Context[] = []
const roots: Root[] = []
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
})
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  vi.useRealTimers()
})

function history(): SessionFollowFrame {
  return {
    type: 'snapshot',
    header: { version: 1, id: sessionId, createdAt: 0, isSeeded: false },
    cursor: 12,
    records: [
      {
        type: 'event',
        event: {
          type: 'user/message',
          seq: 12,
          time: 0,
          data: { content: [{ type: 'text', text: '旧会话原文' }], source: { kind: 'user' } },
          surfaceOp: 'append',
        },
      },
    ],
    hasMore: true,
    projections: { asOfSeq: 12, values: {} },
    assistantStream: { revision: 0 },
  }
}

function available(): MessageEditState {
  return {
    sessionId,
    supported: true,
    busy: false,
    pending: false,
    head: 12,
    choices: [{ seq: 12, text: '旧会话原文' }],
  }
}

class StubService extends cordis.Service {
  constructor(ctx: cordis.Context, name: string, members: object = {}) {
    super(ctx, name)
    Object.assign(this, members)
  }
}

type Registration = {
  name: string
  key?: string
  inject?: (sessionId: string) => unknown
}

async function fixture() {
  const ctx = new cordis.Context()
  contexts.push(ctx)
  const control = feed<SessionControlFrame>()
  control.push({ type: 'baseline', value: { projections: {} } })
  const histories = new Map([
    [sessionId, feed<SessionFollowFrame>()],
    [otherSessionId, feed<SessionFollowFrame>()],
  ])
  const connection = {
    generation: snapshotStore({ id: 1, host: { home: '' } }),
  }
  let editState: MessageEditState = { ...available(), supported: false, choices: [] }
  const readState = vi.fn(async (): Promise<RemoteResult<MessageEditState>> => ({
    ok: true,
    value: editState,
  }))
  const prompt = vi.fn()
  const registrations: Registration[] = []
  const slots = new SlotCore()
  slots.register(
    {
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    },
    () => null,
  )
  slots.register(
    {
      name: 'conversation.chat.node',
      key: 'user',
      children: { 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } },
    },
    () => null,
  )
  const officialUserEntry = slots.entries('conversation.chat.node')[0]!
  // The fixture captures unrelated controls; Node registrations use the public registry unchanged.
  const registerNode = slots.register.bind(slots) as (
    registration: Registration,
    component: unknown,
  ) => () => void
  const summaries: SessionSummary[] = [sessionId, otherSessionId].map((id) => ({
    sessionId: id,
    updatedAt: 0,
    running: false,
    blank: false,
    agentAvailable: false,
  }))
  await ctx.plugin({
    name: 'fixture-services',
    apply(provider: cordis.Context) {
      new StubService(provider, 'slots', {
        inject: (_name: string, install: () => unknown) => install(),
        register: (registration: Registration, component: unknown) => {
          registrations.push(registration)
          return registration.name === 'conversation.chat.node'
            ? registerNode(registration, component)
            : () => {}
        },
        entries: (name: string) => slots.entries(name),
        subscribe: (name: string, listener: () => void) => slots.subscribe(name, listener),
      })
      new StubService(provider, 'connection', connection)
      new StubService(provider, 'fileUpload')
      new StubService(provider, 'typert', { contexts: { registerClient: () => () => {} } })
      new StubService(provider, 'remote', {
        $on: () => () => {},
        $stream: <T,>(options: gateway.RemoteStreamOptions<T>) =>
          new gateway.RemoteStream(connection, options),
      })
      new StubService(provider, 'remote.commands')
      new StubService(provider, 'remote.subagents')
      new StubService(provider, 'remote.session', {
        prompt,
        list: async () => ({ ok: true, value: { items: summaries } }),
        control: (signal: AbortSignal) => control.follow(signal),
        follow: (request: SessionFollowRequest, signal: AbortSignal) => {
          const id = 'sessionId' in request.address ? request.address.sessionId : undefined
          const source = id && histories.get(id)
          if (!source) throw Error('Unexpected test history address')
          return source.follow(signal)
        },
      })
      new StubService(provider, 'remote.oplExecution', { 'message-edit-state': readState })
      new StubService(provider, 'locale', {
        register: () => () => {},
        bind: () => (key: string) => key,
      })
      new StubService(provider, 'uiConversation', {
        events: { register: () => () => {} },
        views: { entries: () => [], subscribe: () => () => {} },
      })
      new StubService(provider, 'uiWorkspace', { openSession: vi.fn() })
    },
  })
  await ctx.plugin(officialController())
  let sessions!: ISessions
  let suite!: cordis.Context
  await ctx.plugin({
    name: 'fixture-client',
    inject: ['sessions', 'remote', 'slots', 'locale'],
    apply(client: cordis.Context) {
      sessions = client.sessions
      suite = client
    },
  })
  await sessions.refresh()
  await suite.plugin(execution)
  const registration = registrations.find((entry) => entry.name === 'conversation.input.activity')!
  expect(registration).toBeDefined()
  let props: MessageEditProps | undefined
  const controlProps = () => (props ??= registration.inject!(sessionId) as MessageEditProps)
  const rowEdit = () => {
    const userEntries = slots
      .entries('conversation.chat.node')
      .filter((entry) => entry.options.key === 'user')
    expect(userEntries).toEqual([officialUserEntry])
    const render = userEntries[0]!.component as (
      props: Pick<MessageEditUserRowProps, 'sessionId'>,
    ) => ReactElement<MessageEditUserRowProps>
    const row = render({ sessionId })
    expect(row.type).toBe(MessageEditUserRow)
    return row.props.edit
  }
  const container = dom.container()
  const root = createRoot(container as unknown as HTMLElement)
  roots.push(root)
  const render = async (controlVisible = true) => {
    const session = rowEdit()
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          controlVisible
            ? createElement(MessageEditControl, {
                ...controlProps(),
                inputActions: { setDraft: vi.fn() },
              })
            : null,
          createElement(MessageEditAction, {
            session,
            seq: 12,
            draft: '',
            onDraft: vi.fn(),
          }),
        ),
      ),
    )
  }
  return {
    sessions,
    control,
    histories,
    get props() {
      return controlProps()
    },
    readState,
    prompt,
    root,
    container,
    render,
    enableEdit: () => (editState = available()),
    setState: (state: MessageEditState) => (editState = state),
    rowEdit,
  }
}

type TestNode = {
  nodeType: number
  childNodes?: TestNode[]
  getAttribute?(name: string): string | null
}
function editButton(node: TestNode): TestNode | undefined {
  if (node.getAttribute?.('aria-label') === '编辑消息') return node
  for (const child of node.childNodes ?? []) {
    const found = editButton(child)
    if (found) return found
  }
  return undefined
}

it('refreshes an initially unsupported edit while its retained first binding opens history', async () => {
  const f = await fixture()
  const reference = f.sessions.retain(sessionId, { source: 'controllerOperation' })
  await f.render()
  expect(reference.binding.session.getSnapshot().openState).toBe('loading')
  expect(f.readState).toHaveBeenCalledTimes(1)
  expect(f.props.session.getSnapshot().state?.supported).toBe(false)
  expect(editButton(f.container)).toBeUndefined()
  f.enableEdit()
  await act(async () => {
    f.histories.get(sessionId)!.push(history())
    await reference.ready
  })
  expect(f.props.session.getSnapshot().state?.supported).toBe(true)
  expect(f.props.session.choice(12)?.text).toBe('旧会话原文')
  expect(editButton(f.container)).toBeDefined()
  expect(f.sessions.retainInfo(sessionId).getSnapshot().referenceCount).toBe(1)
  expect(f.prompt).not.toHaveBeenCalled()
})

it('shares the first row store with a later composer control and loads only after that control mounts', async () => {
  const f = await fixture()
  const reference = f.sessions.retain(sessionId, { source: 'controllerOperation' })
  f.histories.get(sessionId)!.push(history())
  await reference.ready
  const rowEdit = f.rowEdit()
  expect(f.readState).not.toHaveBeenCalled()
  await f.render(false)
  expect(f.readState).not.toHaveBeenCalled()
  expect(editButton(f.container)).toBeUndefined()
  f.enableEdit()
  await f.render()
  expect(f.props.session).toBe(rowEdit)
  expect(f.readState).toHaveBeenCalledTimes(1)
  expect(editButton(f.container)).toBeDefined()
  expect(f.prompt).not.toHaveBeenCalled()
})

it('keeps the bounded cold-history retry after an RPC failure before Host activation', async () => {
  const f = await fixture()
  const reference = f.sessions.retain(sessionId, { source: 'controllerOperation' })
  f.histories.get(sessionId)!.push(history())
  await reference.ready
  f.setState({
    ...available(),
    supported: false,
    head: -1,
    choices: [],
    unavailable: { reason: 'history-busy', retryable: true },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await f.render()
  expect(f.container.textContent).not.toContain('重试编辑')
  f.readState.mockResolvedValueOnce({
    ok: false,
    error: new RemoteError('gateway/internal', 'temporary test transport failure', {}),
  })
  await act(async () => vi.advanceTimersByTimeAsync(300))
  expect(f.props.session.getSnapshot().unavailable).toEqual({
    reason: 'history-unavailable',
    retryable: true,
  })
  f.enableEdit()
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(f.readState).toHaveBeenCalledTimes(3)
  expect(editButton(f.container)).toBeDefined()
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(f.readState).toHaveBeenCalledTimes(3)
  expect(f.prompt).not.toHaveBeenCalled()
})

it('recovers on a model projection when an existing binding is idle and its history is already open', async () => {
  const f = await fixture()
  const reference = f.sessions.retain(sessionId, { source: 'controllerOperation' })
  f.histories.get(sessionId)!.push(history())
  await reference.ready
  await f.render()
  expect(f.props.session.getSnapshot().state?.supported).toBe(false)
  const before = reference.binding.session.getSnapshot()
  f.enableEdit()
  await act(async () => {
    f.control.push({
      type: 'projection',
      sessionId,
      seq: 13,
      changes: [
        {
          key: 'modelSelection',
          val: { next: { provider: 'fixture-pi', model: 'fixture-model' } },
        },
      ],
    })
    await vi.waitFor(() => expect(f.props.session.getSnapshot().state?.supported).toBe(true))
  })
  const after = reference.binding.session.getSnapshot()
  expect([after.running, after.blank, after.openState]).toEqual([
    before.running,
    before.blank,
    before.openState,
  ])
  expect(editButton(f.container)).toBeDefined()
  expect(f.prompt).not.toHaveBeenCalled()
})

it('stops refreshing after unmount while another consumer retains the official binding', async () => {
  const f = await fixture()
  const reference = f.sessions.retain(sessionId, { source: 'controllerOperation' })
  f.histories.get(sessionId)!.push(history())
  await reference.ready
  await f.render()
  await act(async () => f.root.unmount())
  const reads = f.readState.mock.calls.length
  f.enableEdit()
  f.control.push({
    type: 'projection',
    sessionId,
    seq: 13,
    changes: [
      { key: 'modelSelection', val: { next: { provider: 'fixture-pi', model: 'fixture-model' } } },
    ],
  })
  await vi.waitFor(() =>
    expect(
      reference.binding.session.projections.faceOf('modelSelection').getSnapshot(),
    ).toBeDefined(),
  )
  expect(f.readState).toHaveBeenCalledTimes(reads)
  expect(f.sessions.retainInfo(sessionId).getSnapshot().referenceCount).toBe(1)
  expect(f.prompt).not.toHaveBeenCalled()
})
