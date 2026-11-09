/**
 * Regression coverage for the OPL model button against the official Session's
 * pushed `modelSelection` projection.
 *
 * These tests render the real `CombinationSelect` (real hooks, real effects, real
 * official type contract) in a minimal DOM, and drive it exclusively through the
 * public surface the desktop uses: the OPL RPC call and the official projection
 * face. A projection change must reach the trigger without opening the menu,
 * must never leak across Sessions, and must not be overwritten by a slower RPC.
 * The last case runs the real client plugin against stub services, so the slot
 * registration itself is exercised rather than a hand-built prop.
 */
import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { ReactNode } from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  // The published primitives package is not loadable from this offline workspace
  // install (it needs `clsx`), so the four atoms the button uses are stood in for
  // by pass-through elements. Nothing under test lives inside them.
  IconCheckOutlineRegular: () => null,
  IconChevronDownOutlineRegular: () => null,
  IconChevronRightOutlineRegular: () => null,
  StateDot: () => null,
  MenuSurface: React.forwardRef(function MenuSurface(
    props: { children?: ReactNode; role?: string; 'aria-label'?: string },
    ref: React.ForwardedRef<HTMLDivElement>,
  ) {
    return React.createElement('div', { ...props, ref })
  }),
}))

// `./dom.ts` installs the process DOM on import, before React DOM is loaded.
const dom = createTestDom()

const { act } = React
const { CombinationSelect } = await import('../../src/execution/client/CombinationSelect.tsx')
const { createRoot } = await import('react-dom/client')
const execution = await import('../../src/execution/client/index.tsx')

const combination = {
  id: 'dsh/deepseek-flash',
  name: 'DSH(default)',
  enabled: true,
  isDefault: true,
  modelRef: { provider: 'deepseek-official', model: 'deepseek-flash' },
  harnessRef: 'dsh',
  permissionPolicy: 'inherit',
}
const catalog = {
  models: [
    {
      ref: { provider: 'deepseek-official', model: 'deepseek-flash' },
      name: 'DeepSeek Flash',
      source: 'DeepSeek 官方',
      available: true,
    },
  ],
  harnesses: [
    { id: 'dsh', name: 'DSH(default)', available: true },
    { id: 'codex', name: 'Codex', available: true },
  ],
  combinations: [combination],
}
const groups = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        reasoning: {
          defaultEffort: 'medium',
          efforts: [
            { id: 'high', name: '高' },
            { id: 'max', name: '最大' },
          ],
        },
      },
    ],
  },
]
const selection = {
  current: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  groups,
  combination: combination.id,
}

/** Official per-Session projection face: holds the pushed value and its subscribers. */
function createFace(initial: ModelSelectionProjection) {
  let value = initial
  const subscribed = new Set<() => void>()
  const unsubscribes = vi.fn(() => subscribed.clear())
  return {
    face: {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => {
        subscribed.add(listener)
        return unsubscribes
      },
    },
    /** Push one finished projection value, exactly as the control stream does. */
    push(next: ModelSelectionProjection) {
      value = next
      for (const listener of [...subscribed]) listener()
    },
    subscribers: () => subscribed.size,
    unsubscribes,
  }
}

function deferred() {
  let settle: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((resolve) => {
    settle = resolve
  })
  return { promise, settle: (value: unknown) => settle(value) }
}

type Calls = { method: string; args: unknown }[]

function fixture() {
  const calls: Calls = []
  const pending = new Map<string, ReturnType<typeof deferred>>()
  const rpc =
    (table: Record<string, unknown>) =>
    async (method: string, args?: unknown): Promise<unknown> => {
      calls.push({ method, args })
      const held = pending.get(method)
      if (held) return held.promise
      const answer = table[method]
      return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(args) : answer
    }
  const call = rpc({
    catalog: () => catalog,
    combinations: () => [{ id: combination.id, available: true }],
    'model-selection': () => selection,
  }) as unknown as ExecutionCall
  return { call, calls, pending, rpc }
}
/** RPC recorder whose `model-selection` answer is withheld until the test releases it. */
function heldSelectionFixture() {
  const calls: Calls = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const call = (async (method: string, args?: unknown) => {
    calls.push({ method, args })
    if (method === 'catalog') return catalog
    if (method === 'combinations') return [{ id: combination.id, available: true }]
    await held
    return selection
  }) as unknown as ExecutionCall
  return { call, calls, release: () => release() }
}

const mounted: Array<() => Promise<void>> = []
afterEach(async () => {
  while (mounted.length) await mounted.pop()!()
})

/**
 * Mount the real component. `source` mirrors the production `selectionSource`
 * seam: it receives the addressed Session id and answers with that Session's
 * projection face, exactly as the registered slot prop does.
 */
async function mount(props: {
  sessionId: string
  call: ExecutionCall
  source?: (sessionId: string) => unknown
  available?: boolean
}) {
  const container = dom.container()
  const root = createRoot(container as unknown as Element)
  mounted.push(() =>
    act(async () => {
      root.unmount()
    }),
  )
  const source = props.source
  const element = React.createElement(CombinationSelect as never, {
    call: props.call,
    loadingLabel: '正在加载模型…',
    sessionId: props.sessionId,
    locked: false,
    available: props.available ?? true,
    ...(source ? { selectionSource: (id: string) => source(id) } : {}),
  })
  await act(async () => {
    root.render(element)
  })
  const text = () => container.textContent ?? ''
  return {
    container,
    text,
    byLabel: (fragment: string) => text().includes(fragment),
    unmount: async () => {
      await mounted.pop()!()
    },
    /** Render the same component again (Session switch / parent update). */
    rerender: async (next: Parameters<typeof mount>[0]) =>
      act(async () => {
        const rerenderSource = next.source
        root.render(
          React.createElement(CombinationSelect as never, {
            call: next.call,
            loadingLabel: '正在加载模型…',
            sessionId: next.sessionId,
            locked: false,
            available: next.available ?? true,
            ...(rerenderSource ? { selectionSource: (id: string) => rerenderSource(id) } : {}),
          }),
        )
      }),
  }
}

describe('OPL model button selection projection', () => {
  it.each([undefined, 'retired-id'])(
    'does not guess a Harness when the Host returns no matching combination: %s',
    async (id) => {
      const f = fixture()
      const call = f.rpc({
        catalog: () => catalog,
        combinations: () => [{ id: combination.id, available: true }],
        'model-selection': () => ({ ...selection, combination: id }),
      }) as ExecutionCall
      const view = await mount({ sessionId: 'unresolved', call })
      expect(view.text()).toContain('DeepSeek Flash')
      expect(view.text()).not.toContain('DSH(default)')
      expect(f.calls.some((x) => x.method === 'reasoning-preflight')).toBe(false)
    },
  )

  it('shows provider-owned effort for an external Harness without a CLI-store marker', async () => {
    const f = fixture()
    const held = deferred()
    f.pending.set('reasoning-preflight', held)
    const call = f.rpc({
      catalog: () => ({ ...catalog, combinations: [{ ...combination, harnessRef: 'codex' }] }),
      combinations: () => [{ id: combination.id, available: true }],
      'model-selection': () => selection,
      'reasoning-preflight': () => ({
        status: 'known',
        efforts: groups[0]!.models[0]!.reasoning.efforts,
      }),
    }) as ExecutionCall
    const view = await mount({ sessionId: 'provider-effort', call })
    expect(view.text()).toContain('高')
    await act(async () => {
      held.settle({ status: 'known', efforts: groups[0]!.models[0]!.reasoning.efforts })
    })
    expect(view.text()).toContain('高')
  })

  it('keeps the Host-confirmed effort visible while CLI controls are pending', async () => {
    const f = fixture()
    const held = deferred()
    f.pending.set('reasoning-preflight', held)
    const call = f.rpc({
      catalog: () => ({ ...catalog, combinations: [{ ...combination, harnessRef: 'codex' }] }),
      combinations: () => [{ id: combination.id, available: true }],
      'model-selection': () => ({ ...selection, effortSource: 'harness' }),
    }) as ExecutionCall
    const view = await mount({ sessionId: 'pending-effort', call })
    expect(view.text()).toContain('高')
    await act(async () => {
      held.settle({ status: 'unavailable', efforts: [] })
    })
    expect(view.text()).toContain('高')
  })

  it('keeps CLI effort separate from an automatic native provider effort', async () => {
    const { ModelSelectionState } =
      await import('../../src/execution/client/use-model-selection.ts')
    const face = createFace({ next: selection.current, lastUsed: null })
    let chosen: string | undefined = 'low'
    const state = new ModelSelectionState(async () => ({
      ...selection,
      current: { ...combination.modelRef, ...(chosen ? { reasoningEffort: chosen } : {}) },
      effortSource: 'harness',
    }))
    state.reset('session-1', face.face)
    await state.refresh('session-1')
    expect(state.projected()?.current?.reasoningEffort).toBe('low')
    chosen = undefined
    await state.refresh('session-1')
    expect(state.projected()?.current?.reasoningEffort).toBeUndefined()
    face.push({
      next: { provider: 'other', model: 'other', reasoningEffort: 'max' },
      lastUsed: null,
    })
    expect(state.projected()?.combination).toBeUndefined()
    expect(state.projected()?.effortSource).toBeUndefined()
  })

  it('shows the current selection while Harness availability is still pending', async () => {
    const { call, pending } = fixture()
    const held = deferred()
    pending.set('combinations', held)
    const view = await mount({ sessionId: 'loading-models', call })
    expect(view.text()).toContain('DeepSeek Flash')
    expect(view.text()).not.toContain('请选择模型')
    await act(async () => held.settle([{ id: combination.id, available: true }]))
    expect(view.text()).toContain('DeepSeek Flash')
  })

  it('shows the effective default with an empty new-session projection instead of the first menu item', async () => {
    const face = createFace({ next: null, lastUsed: null })
    const aws = {
      ...combination,
      id: 'aws',
      modelRef: { provider: 'opl-gateway', model: 'aws::opus' },
    }
    const call = (async (method: string) => {
      if (method === 'catalog')
        return {
          ...catalog,
          models: [
            { ref: aws.modelRef, name: 'AWS Opus', source: 'AWS', available: true },
            ...catalog.models,
          ],
          combinations: [aws, combination],
        }
      if (method === 'combinations')
        return [aws, combination].map((item) => ({ id: item.id, available: true }))
      return selection
    }) as unknown as ExecutionCall
    const view = await mount({ sessionId: 'new-session', call, source: () => face.face })
    expect(view.text()).toContain('DeepSeek Flash')
    expect(view.text()).not.toContain('AWS Opus')
  })
  it('does not invent a selection when neither the projection nor Host has one', async () => {
    const face = createFace({ next: null, lastUsed: null })
    const { rpc } = fixture()
    const call = rpc({
      catalog,
      combinations: [{ id: combination.id, available: true }],
      'model-selection': { current: null, groups },
    }) as unknown as ExecutionCall
    const view = await mount({ sessionId: 'new-session', call, source: () => face.face })
    expect(view.text()).toContain('请选择模型')
    expect(view.text()).not.toContain('DeepSeek Flash')
  })

  it('follows an external model change instead of keeping the previous combination label', async () => {
    const face = createFace({ lastUsed: null, next: selection.current })
    const second = {
      ...combination,
      id: 'minimax-code/MiniMax-M3',
      name: 'M3 thinking',
      harnessRef: 'minimax-code',
      modelRef: { provider: 'minimax-official', model: 'MiniMax-M3' },
    }
    const call = (async (method: string) => {
      if (method === 'catalog')
        return {
          ...catalog,
          models: [
            ...catalog.models,
            { ref: second.modelRef, name: 'M3', source: 'MiniMax', available: true },
          ],
          harnesses: [
            ...catalog.harnesses,
            { id: 'minimax-code', name: 'MiniMax Code', available: true },
          ],
          combinations: [...catalog.combinations, second],
        }
      if (method === 'combinations')
        return [combination, second].map((item) => ({ id: item.id, available: true }))
      return face.face.getSnapshot()?.next?.model === second.modelRef.model
        ? { ...selection, current: second.modelRef, combination: second.id }
        : selection
    }) as unknown as ExecutionCall
    const view = await mount({ sessionId: 'session-1', call, source: () => face.face })
    expect(view.text()).toContain('DeepSeek Flash')
    await act(async () => face.push({ lastUsed: selection.current, next: second.modelRef }))
    expect(view.text()).toContain('M3 · MiniMax Code')
    expect(view.text()).not.toContain('DeepSeek Flash')
  })
  it('shows an externally changed effort without opening the menu', async () => {
    const face = createFace({
      lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    })
    const { call } = fixture()
    const view = await mount({ sessionId: 'session-1', call, source: () => face.face })
    expect(view.text()).toContain('DeepSeek Flash · DSH(default)')
    expect(view.text()).toContain('高')
    expect(view.byLabel('最大')).toBe(false)

    // The official Host recorded a new selection for the next request; the
    // control stream pushes it while the menu stays closed.
    await act(async () => {
      face.push({
        lastUsed: {
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          reasoningEffort: 'high',
        },
        next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      })
    })
    expect(view.text()).toContain('最大')
    expect(view.byLabel('高')).toBe(false)
    // Display reflects the next request, not the already-issued one.
    expect(view.text()).not.toContain('高')
  })

  it('keeps the pushed selection while the opening read is still in flight', async () => {
    const face = createFace({
      lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    })
    const { call, release } = heldSelectionFixture()
    const view = await mount({ sessionId: 'session-1', call, source: () => face.face })
    expect(view.text()).not.toContain('高')

    // The external change lands before the composer's own read answers.
    await act(async () => {
      face.push({
        lastUsed: {
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          reasoningEffort: 'high',
        },
        next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      })
    })
    expect(view.text()).not.toContain('最大')

    // The stale answer must not roll the display back to the opening value.
    await act(async () => {
      release()
    })
    expect(view.text()).toContain('最大')
    expect(view.byLabel('高')).toBe(false)
  })

  it('follows the next selection while an already-issued request keeps its own effort', async () => {
    const face = createFace({
      lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      next: null,
    })
    const { call } = fixture()
    const view = await mount({ sessionId: 'session-1', call, source: () => face.face })
    expect(view.text()).toContain('高')

    // Only `lastUsed` changes: an external writer consumed an earlier choice.
    // The displayed value must keep following `next`, which still falls back to it.
    await act(async () => {
      face.push({
        lastUsed: {
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          reasoningEffort: 'max',
        },
        next: null,
      })
    })
    expect(view.text()).toContain('最大')
  })

  it('ignores projection frames that belong to another Session', async () => {
    const mine = createFace({
      lastUsed: null,
      next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    })
    const other = createFace({
      lastUsed: null,
      next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    })
    const { call } = fixture()
    const view = await mount({
      sessionId: 'session-1',
      call,
      source: (sessionId) => (sessionId === 'session-1' ? mine.face : other.face),
    })
    expect(view.text()).toContain('高')

    await act(async () => {
      other.push({
        lastUsed: null,
        next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      })
    })
    expect(view.text()).toContain('高')
    expect(view.byLabel('最大')).toBe(false)
    expect(other.subscribers()).toBe(0)
  })

  it('keeps the new Session when the previous Session read answers late', async () => {
    const first = fixture()
    const second = fixture()
    const late = deferred()
    first.pending.set('model-selection', late)
    const mine = createFace({
      lastUsed: null,
      next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    })
    const { call: secondCall } = second
    const view = await mount({ sessionId: 'session-a', call: first.call, source: () => mine.face })
    expect(first.calls.filter((entry) => entry.method === 'model-selection')).toHaveLength(1)

    await view.rerender({ sessionId: 'session-b', call: secondCall, source: () => mine.face })
    expect(second.calls.filter((entry) => entry.method === 'model-selection')).toHaveLength(1)
    expect(view.text()).toContain('高')

    // The abandoned Session A read finally answers with a different selection.
    await act(async () => {
      first.pending.get('model-selection')!.settle({
        current: {
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          reasoningEffort: 'max',
        },
        groups,
        combination: combination.id,
      })
    })
    expect(view.text()).toContain('高')
    expect(view.byLabel('最大')).toBe(false)
  })

  it('unsubscribes the projection face on unmount', async () => {
    const face = createFace({
      lastUsed: null,
      next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    })
    const { call, calls } = fixture()
    const view = await mount({ sessionId: 'session-1', call, source: () => face.face })
    expect(face.subscribers()).toBe(1)

    await view.unmount()
    expect(face.subscribers()).toBe(0)
    expect(face.unsubscribes).toHaveBeenCalledTimes(1)

    const before = calls.length
    face.push({
      lastUsed: null,
      next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    })
    await act(async () => {})
    expect(calls.length).toBe(before)
  })

  it('subscribes the registered slot to the official projection face', async () => {
    const face = createFace({
      lastUsed: null,
      next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    })
    const binding = { session: { projections: { faceOf: () => face.face } } }
    const { calls } = fixture()
    const { ctx, registration } = await pluginFixture({ 'session-1': binding }, calls)

    // The registered slot prop must resolve the addressed Session's real
    // projection face — not a copy, and not another Session's.
    const props = registration.inject!('session-1') as {
      call: ExecutionCall
      selectionSource: (sessionId: string) => unknown
    }
    expect(props.selectionSource('session-1')).toBe(face.face)
    expect(props.selectionSource('session-unknown')).toBeUndefined()

    const view = await mount({
      sessionId: 'session-1',
      call: props.call,
      source: props.selectionSource as (sessionId: string) => unknown,
    })
    expect(face.subscribers()).toBe(1)
    await act(async () => {
      face.push({
        lastUsed: null,
        next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      })
    })
    expect(view.text()).toContain('最大')
    await view.unmount()
    expect(face.subscribers()).toBe(0)
    await ctx.fiber.dispose()
  })
})

/** Minimal Slots service: keeps registrations so a spec can read their inject result. */
class Slots extends Service {
  readonly registrations: Array<{
    name: string
    id?: string
    inject?: (sessionId: string) => unknown
  }> = []
  constructor(ctx: Context) {
    super(ctx, 'slots')
  }
  inject(_name: string, callback: () => unknown) {
    return callback()
  }
  entries() {
    return []
  }
  subscribe() {
    return () => {}
  }
  register(registration: { name: string; id?: string; inject?: (sessionId: string) => unknown }) {
    this.registrations.push(registration)
    return this.ctx.effect(() => () => {
      const index = this.registrations.indexOf(registration)
      if (index >= 0) this.registrations.splice(index, 1)
    })
  }
}

/**
 * Run the real client plugin over stub services.
 *
 * Services live in sibling provider fibers, exactly as the desktop mounts them,
 * so the plugin's own `inject` list is what satisfies its access. The stub
 * Remote namespace answers like the generated client does: one
 * `{ ok, value }` result per method.
 */
async function pluginFixture(
  bindings: Record<string, unknown>,
  calls: Calls,
): Promise<{
  ctx: Context
  registration: { name: string; inject?: (sessionId: string) => unknown }
}> {
  const ok = (value: unknown) => ({ ok: true as const, value })
  const methods = {
    catalog: async () => {
      calls.push({ method: 'catalog', args: undefined })
      return ok(catalog)
    },
    combinations: async () => {
      calls.push({ method: 'combinations', args: undefined })
      return ok([{ id: combination.id, available: true }])
    },
    'model-selection': async (input: { sessionId: string }) => {
      calls.push({ method: 'model-selection', args: input })
      return ok(selection)
    },
  }
  const ctx = new Context()
  let slots!: Slots
  await ctx.plugin({
    name: 'fixture-services',
    apply(provider: Context) {
      slots = new Slots(provider)
      new (class extends Service {})(provider, 'remote')
      new (class extends Service {
        prompt = vi.fn()
        constructor(context: Context) {
          super(context, 'remote.session')
        }
      })(provider)
      new (class extends Service {
        events = { register: () => () => {} }
        views = { entries: () => [], subscribe: () => () => {} }
      })(provider, 'uiConversation')
      new (class extends Service {
        openSession = vi.fn()
      })(provider, 'uiWorkspace')
      new (class extends Service {
        register() {
          return () => {}
        }
        bind() {
          return (key: string) => key
        }
      })(provider, 'locale')
      new (class extends Service {
        constructor(context: Context) {
          super(context, 'sessions')
          Object.assign(this, {
            binding: (id: string) => bindings[id],
            subagentAddress: () => undefined,
          })
        }
      })(provider)
      new (class extends Service {
        constructor(context: Context) {
          super(context, 'remote.oplExecution')
          Object.assign(this, methods)
        }
      })(provider)
    },
  })
  let client!: Context
  await ctx.plugin({
    name: 'client-root',
    inject: ['slots', 'sessions', 'remote', 'locale'],
    apply(scope: Context) {
      client = scope
    },
  })
  await client.plugin(execution)
  const registration = slots.registrations.find((item) => item.name === 'conversation.input.model')
  expect(registration, 'model slot must stay registered').toBeDefined()
  return { ctx: client, registration: registration! }
}
