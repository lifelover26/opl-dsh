// @vitest-environment jsdom
import { act, createElement, memo, useSyncExternalStore, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installActivityCounts } from '../../src/conversation-stats/client/activity.tsx'
import {
  StatisticsPreferenceRow,
  type StatisticsSettings,
} from '../../src/conversation-stats/client/PreferenceRow.tsx'
import { zh } from '../../src/conversation-stats/client/locales.ts'

// The official runtime supplies primitive peer dependencies; the isolated Desktop test exercises its real Menu.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  Menu: ({
    anchor,
    open,
    items,
    onSelect,
  }: {
    anchor: React.ReactNode
    open: boolean
    items: { id: string; label: string }[]
    onSelect(id: string): void
  }) =>
    createElement(
      'div',
      null,
      anchor,
      open &&
        createElement(
          'div',
          { role: 'menu' },
          items.map((item) =>
            createElement(
              'button',
              { key: item.id, role: 'menuitem', onClick: () => onSelect(item.id) },
              item.label,
            ),
          ),
        ),
    ),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  document.body.replaceChildren()
})

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

function settings(mode: 'current' | 'history' = 'current') {
  const store = observable<ConfigFormSnapshot<StatisticsSettings>>({
    status: 'ready',
    value: { conversationStats: mode },
    base: {},
    user: {},
    revision: 4,
    writable: true,
  })
  const set = vi.fn(async (_field: string, value: unknown) => {
    store.publish({
      ...store.getSnapshot(),
      value: { conversationStats: value as 'current' | 'history' },
      revision: 5,
    })
    return true
  })
  const form: ConfigForm<StatisticsSettings> & { store: typeof store } = {
    store,
    getSnapshot() {
      return this.store.getSnapshot()
    },
    subscribe(listener) {
      return this.store.subscribe(listener)
    },
    set,
    unset: vi.fn(),
    mutate: vi.fn(),
  }
  return { form, store, set }
}

function render(element: Parameters<Root['render']>[0]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  cleanup.push(() => act(() => root.unmount()))
  act(() => root.render(element))
  return { root, container }
}

describe('activity count scope', () => {
  function fixture() {
    const historical = { turns: 4, steps: 9, llmMs: 300, toolMs: 500, decodeTokens: 87 }
    const projection = observable<Record<string, unknown>>({
      sessionStats: historical,
      oplConversationCounts: { turns: 2, steps: 3 },
    })
    const preference = settings()
    const read = vi.fn((key: string, selector?: (value: unknown) => unknown, _equal?: unknown) => {
      const all = useSyncExternalStore(projection.subscribe, projection.getSnapshot)
      return selector ? selector(all[key]) : all[key]
    })
    const equal = Object.is
    let observed: { stats: unknown; selected: unknown; other: unknown; marker: unknown } | undefined
    const original = memo((props: { useProjection: UseProjection; marker?: unknown }) => {
      const get = props.useProjection as typeof read
      const stats = get('sessionStats') as typeof historical
      observed = {
        stats,
        selected: get('sessionStats', (value) => (value as typeof historical)?.steps, equal),
        other: get('other'),
        marker: props.marker,
      }
      return createElement('span', null, `${stats?.turns}/${stats?.steps}`)
    })
    const slots = new SlotCore()
    slots.register(
      {
        name: 'root',
        children: { 'conversation.composer.dock': { kind: 'list', scope: 'session' } },
      },
      () => null,
    )
    const register = (id = 'activity') =>
      slots.register({ name: 'conversation.composer.dock', id }, original as ComponentType)
    const off = register()
    register('usage')
    const entries = () => slots.entriesOfSlot('conversation.composer.dock')
    const entry = entries().find((value) => value.options.id === 'activity')!
    const uninstall = installActivityCounts({
      entries,
      subscribe: (listener) => slots.subscribe('conversation.composer.dock', listener),
      form: preference.form,
    })
    cleanup.push(uninstall)
    const view = render(
      createElement(entry.component, { useProjection: read, marker: 'native-props' }),
    )
    return {
      ...view,
      preference,
      historical,
      projection,
      read,
      equal,
      entry,
      original,
      entries,
      off,
      register,
      uninstall,
      get observed() {
        return observed!
      },
    }
  }

  it('replaces counts only and preserves native timing, selectors, props and the usage registration', () => {
    const f = fixture()
    expect(f.container.textContent).toBe('2/3')
    expect(f.observed.stats).toEqual({ ...f.historical, turns: 2, steps: 3 })
    expect(f.observed.selected).toBe(3)
    expect(f.observed.marker).toBe('native-props')
    expect(f.observed.other).toBeUndefined()
    expect(
      f.read.mock.calls.some(([key, , equal]) => key === 'sessionStats' && equal === f.equal),
    ).toBe(true)
    expect(f.entries().find((entry) => entry.options.id === 'usage')!.component).toBe(f.original)
  })

  it('switches immediately through the shared preference and preserves the historical object', () => {
    const f = fixture()
    act(() =>
      f.preference.store.publish({
        ...f.preference.store.getSnapshot(),
        value: { conversationStats: 'history' },
      }),
    )
    expect(f.container.textContent).toBe('4/9')
    expect(f.observed.stats).toBe(f.historical)
    act(() =>
      f.preference.store.publish({
        ...f.preference.store.getSnapshot(),
        value: { conversationStats: 'current' },
      }),
    )
    act(() =>
      f.projection.publish({
        sessionStats: { ...f.historical, steps: 10 },
        oplConversationCounts: { turns: 2, steps: 4 },
      }),
    )
    expect(f.container.textContent).toBe('2/4')
  })

  it('uses native statistics while the current-history projection is absent', () => {
    const f = fixture()
    act(() => f.projection.publish({ sessionStats: f.historical }))
    expect(f.observed.stats).toBe(f.historical)
    expect(f.container.textContent).toBe('4/9')
  })

  it('keeps native counts until a Host preference has arrived', () => {
    const f = fixture()
    act(() =>
      f.preference.store.publish({
        ...f.preference.store.getSnapshot(),
        status: 'loading',
        value: undefined,
      }),
    )
    expect(f.observed.stats).toBe(f.historical)
  })

  it('decorates a replacement registration and restores only components it still owns', async () => {
    const f = fixture()
    await act(async () => f.off())
    expect(f.entry.component).toBe(f.original)
    await act(async () => {
      f.register()
    })
    const next = f.entries().find((entry) => entry.options.id === 'activity')!
    expect(next.component).not.toBe(f.original)
    const replacement = () => null
    next.component = replacement
    f.uninstall()
    expect(next.component).toBe(replacement)
  })
})

describe('Host-backed count preference', () => {
  function fixture() {
    const value = settings()
    const view = render(
      createElement(StatisticsPreferenceRow, {
        form: value.form,
        t: (key: keyof typeof zh) => zh[key],
      }),
    )
    const button = () => view.container.querySelector<HTMLButtonElement>('button')!
    async function choose(label: string) {
      await act(async () => button().click())
      const item = Array.from(
        document.querySelectorAll<HTMLElement>('[role=menuitem],[role=menuitemradio]'),
      ).find((item) => item.textContent?.includes(label))
      expect(item, document.body.textContent ?? '').toBeDefined()
      await act(async () => item!.click())
    }
    return { ...value, ...view, button, choose }
  }

  it('saves a choice through the existing settings form and reflects accepted Host state', async () => {
    const f = fixture()
    expect(f.button().textContent).toContain('当前对话')
    await f.choose('历史累计')
    expect(f.set).toHaveBeenCalledExactlyOnceWith('conversationStats', 'history')
    expect(f.button().textContent).toContain('历史累计')
    expect(f.container.querySelector('[role=alert]')).toBeNull()
    expect(document.querySelector('[role=menu]')).toBeNull()
  })

  it.each(['loading', 'unavailable'] as const)(
    'does not offer writes when the namespace is %s',
    (status) => {
      const f = fixture()
      act(() => f.store.publish({ ...f.store.getSnapshot(), status }))
      expect(f.button().disabled).toBe(true)
      expect(f.set).not.toHaveBeenCalled()
    },
  )

  it.each(['refused', 'transport'] as const)(
    'keeps the accepted choice and reports a %s failure',
    async (failure) => {
      const f = fixture()
      f.set.mockImplementationOnce(async () => {
        if (failure === 'transport') throw new Error('unavailable')
        return false
      })
      await f.choose('历史累计')
      expect(f.button().textContent).toContain('当前对话')
      expect(f.container.querySelector('[role=alert]')?.textContent).toBe('未能保存，请重试。')
      expect(f.set).toHaveBeenCalledTimes(1)
      await f.choose('历史累计')
      expect(f.set).toHaveBeenCalledTimes(2)
      expect(f.button().textContent).toContain('历史累计')
      expect(f.container.querySelector('[role=alert]')).toBeNull()
    },
  )
})
