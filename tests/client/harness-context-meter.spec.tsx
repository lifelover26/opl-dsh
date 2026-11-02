import './dom.ts'
import { createTestDom } from './dom.ts'
import { act, createElement, memo, useSyncExternalStore, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { describe, expect, it, vi } from 'vitest'
import { installHarnessContextMeter } from '../../src/execution/client/HarnessContextMeter.tsx'
import type { ModelRef } from '../../src/execution/contracts/catalog.ts'
import type { HarnessContextReading } from '../../src/execution/contracts/usage.ts'

const vibe: ModelRef = {
  provider: 'our-free-model',
  model: 'mistralai/mistral-large-4-1t-a52b',
}
const step: ModelRef = { provider: 'our-free-model', model: 'step-5-preview-free' }
const deepseek: ModelRef = { provider: 'deepseek', model: 'deepseek-chat' }
const nativePressure = { pressureTokens: 910_000, projectedTokens: 920_000, contextWindow: 131_072 }
const nativeBreakdown = { messages: 910_000 }

type ReadProjection = (
  key: string,
  selector?: (value: unknown) => unknown,
  equal?: (left: unknown, right: unknown) => boolean,
) => unknown

type RuntimeComposerProps = ComposerBarProps & { useProjection: UseProjection }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function reading(
  model: ModelRef,
  contextUsage: HarnessContextReading['contextUsage'],
): HarnessContextReading {
  return {
    ...model,
    harness: model.model === vibe.model ? 'vibe' : 'step-code',
    operationId: 'completed-operation',
    contextUsage,
  }
}

function registry(component: ComponentType<ComposerBarProps>) {
  const core = new SlotCore()
  core.register(
    {
      name: 'root',
      children: { 'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' } },
    },
    () => null,
  )
  const register = () =>
    core.register(
      {
        name: 'conversation.composer.bar',
        children: { 'conversation.input.right': { kind: 'list', scope: 'session' } },
      },
      component,
    )
  return { core, register, entries: () => core.entries('conversation.composer.bar') }
}

async function mount(model: ModelRef = vibe) {
  const listeners = new Set<() => void>()
  let state = { selection: { next: model }, running: false }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const read = vi.fn(
    (
      key: string,
      selector?: (value: unknown) => unknown,
      _equal?: (left: unknown, right: unknown) => boolean,
    ) => {
      const snapshot = useSyncExternalStore(subscribe, () => state)
      const value =
        key === 'modelSelection'
          ? snapshot.selection
          : key === 'contextPressure'
            ? nativePressure
            : key === 'contextBreakdown'
              ? nativeBreakdown
              : 'native-other-projection'
      return selector ? selector(value) : value
    },
  )
  let observed:
    | {
        pressure: unknown
        breakdown: unknown
        selected: unknown
        other: unknown
        props: RuntimeComposerProps
      }
    | undefined
  const equal = Object.is
  const original = memo((props: ComposerBarProps) => {
    const projection = (props as RuntimeComposerProps).useProjection as ReadProjection
    const pressure = projection('contextPressure')
    const breakdown = projection('contextBreakdown')
    const selected = projection(
      'contextPressure',
      (value) => (value as { contextWindow?: number } | undefined)?.contextWindow,
      equal,
    )
    const other = projection('other')
    observed = { pressure, breakdown, selected, other, props: props as RuntimeComposerProps }
    return createElement('textarea', {
      disabled: props.disabled,
      placeholder: JSON.stringify(pressure ?? 'hidden'),
    })
  })
  const slots = registry(original)
  slots.register()
  const entry = slots.entries()[0]!
  const requests: ReturnType<typeof deferred<HarnessContextReading | null>>[] = []
  const contextUsage = vi.fn((_sessionId: string) => {
    const request = deferred<HarnessContextReading | null>()
    requests.push(request)
    return request.promise
  })
  const sessions = new Map<string, Set<() => void>>()
  const sessionChanges = vi.fn((sessionId: string, listener: () => void) => {
    let set = sessions.get(sessionId)
    if (!set) sessions.set(sessionId, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  })
  const uninstall = installHarnessContextMeter({
    entries: slots.entries,
    subscribe: (listener) => slots.core.subscribe('conversation.composer.bar', listener),
    contextUsage,
    sessionChanges,
  })
  const dom = createTestDom()
  const container = dom.container()
  const root = createRoot(container as unknown as HTMLElement)
  const keyboard = {}
  const inputActions = {}
  const useInput = vi.fn()
  let props = {
    sessionId: 'session-a',
    useProjection: read,
    useSession: (select: (value: { running: boolean }) => unknown) =>
      select(useSyncExternalStore(subscribe, () => state)),
    useInput,
    keyboard,
    inputActions,
    disabled: true,
  } as unknown as ComposerBarProps
  const render = () => root.render(createElement(entry.component, props))
  await act(async () => render())
  return {
    slots,
    entry,
    original,
    requests,
    contextUsage,
    sessionChanges,
    read,
    equal,
    keyboard,
    inputActions,
    useInput,
    get observed() {
      return observed!
    },
    async change(next: Partial<typeof state>) {
      await act(async () => {
        state = { ...state, ...next }
        for (const listener of listeners) listener()
      })
    },
    async session(sessionId: string | undefined) {
      await act(async () => {
        props = { ...props, sessionId: sessionId as never }
        render()
      })
    },
    async changed(sessionId = 'session-a') {
      await act(async () => {
        for (const listener of sessions.get(sessionId) ?? []) listener()
      })
    },
    async resolve(index: number, value: HarnessContextReading | null) {
      await act(async () => requests[index]!.resolve(value))
    },
    async reject(index: number) {
      await act(async () => requests[index]!.reject(new Error('statistics unavailable')))
    },
    async dispose() {
      await act(async () => root.unmount())
      uninstall()
    },
  }
}

describe('official Harness context meter projection', () => {
  it('retains native DSH projections and injected composer operations', async () => {
    const f = await mount(deepseek)
    try {
      expect(f.observed.pressure).toBe(nativePressure)
      expect(f.observed.breakdown).toBe(nativeBreakdown)
      expect(f.observed.props.useProjection).toBe(f.read)
      expect(f.observed.props.keyboard).toBe(f.keyboard)
      expect(f.observed.props.inputActions).toBe(f.inputActions)
      expect(f.observed.props.useInput).toBe(f.useInput)
      expect(f.contextUsage).not.toHaveBeenCalled()
      expect(f.sessionChanges).not.toHaveBeenCalled()
    } finally {
      await f.dispose()
    }
  })

  it.each([vibe, step])(
    'uses $model occupancy in the resident official composer',
    async (model) => {
      const f = await mount(model)
      try {
        expect(f.observed.pressure).toBeUndefined()
        expect(f.observed.breakdown).toBeUndefined()
        await f.resolve(0, reading(model, { used: 128, size: 1000, estimated: true }))
        expect(f.observed.pressure).toEqual({
          pressureTokens: 128,
          projectedTokens: 128,
          contextWindow: 1000,
        })
        expect(f.observed.selected).toBe(1000)
        expect(f.observed.breakdown).toBeUndefined()
        expect(f.observed.other).toBe('native-other-projection')
        expect(
          f.read.mock.calls.some(
            ([key, _selector, equal]) => key === 'contextPressure' && equal === f.equal,
          ),
        ).toBe(true)
        expect(f.observed.props.keyboard).toBe(f.keyboard)
        expect(f.observed.props.inputActions).toBe(f.inputActions)
        expect(f.observed.props.disabled).toBe(true)
        expect(f.slots.entries()).toEqual([f.entry])
        expect(f.slots.core.spec('conversation.input.right')).toBeDefined()
      } finally {
        await f.dispose()
      }
    },
  )

  it.each([null, reading(vibe, { size: 1000 }), reading(vibe, { used: 128 })])(
    'keeps the meter hidden when either observation is unknown (%j)',
    async (value) => {
      const f = await mount()
      try {
        await f.resolve(0, value)
        expect(f.observed.pressure).toBeUndefined()
        expect(f.observed.selected).toBeUndefined()
        expect(f.observed.breakdown).toBeUndefined()
      } finally {
        await f.dispose()
      }
    },
  )

  it.each([0, 1200])(
    'retains the reported occupancy %i against an effective budget',
    async (used) => {
      const f = await mount()
      try {
        await f.resolve(0, reading(vibe, { used, size: 1000, estimated: true }))
        expect(f.observed.pressure).toEqual({
          pressureTokens: used,
          projectedTokens: used,
          contextWindow: 1000,
        })
      } finally {
        await f.dispose()
      }
    },
  )

  it('clears an existing reading while statistics refresh and after a failure', async () => {
    const f = await mount()
    try {
      await f.resolve(0, reading(vibe, { used: 100, size: 1000 }))
      expect(f.observed.selected).toBe(1000)
      await f.changed()
      expect(f.observed.pressure).toBeUndefined()
      await f.reject(1)
      expect(f.observed.pressure).toBeUndefined()
      await f.changed()
      await f.resolve(2, { ...reading(vibe, { used: 100, size: 1000 }), harness: 'step-code' })
      expect(f.observed.pressure).toBeUndefined()
    } finally {
      await f.dispose()
    }
  })

  it('rejects an older RPC result and hides completed context while a new turn runs', async () => {
    const f = await mount()
    try {
      await f.changed()
      await f.resolve(1, reading(vibe, { used: 20, size: 1000 }))
      await f.resolve(0, reading(vibe, { used: 900, size: 1000 }))
      expect(f.observed.pressure).toMatchObject({ projectedTokens: 20 })
      await f.change({ running: true })
      expect(f.observed.pressure).toBeUndefined()
      await f.changed()
      expect(f.requests).toHaveLength(2)
      await f.change({ running: false })
      expect(f.observed.pressure).toBeUndefined()
      await f.resolve(2, reading(vibe, { used: 30, size: 1000 }))
      expect(f.observed.pressure).toMatchObject({ projectedTokens: 30 })
    } finally {
      await f.dispose()
    }
  })

  it('clears switched models and sessions before accepting their own completed context', async () => {
    const f = await mount()
    try {
      await f.change({ selection: { next: step } })
      expect(f.observed.pressure).toBeUndefined()
      await f.resolve(0, reading(vibe, { used: 900, size: 1000 }))
      expect(f.observed.pressure).toBeUndefined()
      await f.resolve(1, reading(step, { used: 20, size: 2000 }))
      expect(f.observed.pressure).toMatchObject({ projectedTokens: 20, contextWindow: 2000 })
      await f.changed()
      await f.session('session-b')
      expect(f.observed.pressure).toBeUndefined()
      await f.resolve(2, reading(step, { used: 800, size: 2000 }))
      expect(f.observed.pressure).toBeUndefined()
      await f.resolve(3, reading(step, { used: 40, size: 2000 }))
      expect(f.observed.pressure).toMatchObject({ projectedTokens: 40, contextWindow: 2000 })
      expect(f.contextUsage.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        'session-a',
        'session-a',
        'session-a',
        'session-b',
      ])
      await f.changed('session-a')
      expect(f.requests).toHaveLength(4)
      await f.change({ selection: { next: deepseek } })
      expect(f.observed.pressure).toBe(nativePressure)
      expect(f.observed.breakdown).toBe(nativeBreakdown)
    } finally {
      await f.dispose()
    }
  })

  it('releases a pending session when the fresh composer becomes unbound', async () => {
    const f = await mount()
    try {
      await f.session(undefined)
      await f.resolve(0, reading(vibe, { used: 800, size: 1000 }))
      expect(f.requests).toHaveLength(1)
      await f.session('session-b')
      expect(f.observed.pressure).toBeUndefined()
      await f.resolve(1, reading(vibe, { used: 40, size: 1000 }))
      expect(f.observed.pressure).toMatchObject({ projectedTokens: 40 })
    } finally {
      await f.dispose()
    }
  })

  it('decorates a late official registration and restores each owner without duplicating slots', async () => {
    const original = memo(() => createElement('textarea'))
    const slots = registry(original)
    const uninstall = installHarnessContextMeter({
      entries: slots.entries,
      subscribe: (listener) => slots.core.subscribe('conversation.composer.bar', listener),
      contextUsage: async () => null,
      sessionChanges: () => () => {},
    })
    const unregister = slots.register()
    await Promise.resolve()
    const first = slots.entries()[0]!
    expect(first.component).not.toBe(original)
    unregister()
    slots.register()
    await Promise.resolve()
    expect(first.component).toBe(original)
    const replacement = slots.entries()[0]!
    expect(replacement.component).not.toBe(original)
    expect(slots.core.spec('conversation.input.right')).toBeDefined()
    uninstall()
    expect(replacement.component).toBe(original)
  })
})
