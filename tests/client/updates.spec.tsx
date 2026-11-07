// @vitest-environment jsdom
/** Update settings use real components and requests controlled at the Host API. */
import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type {
  OplUpdateApi,
  OplUpdatePolicy,
  OplUpdateRelease,
  OplUpdateStatus,
} from '../../src/updates/contracts.ts'
import type { Config } from '../../src/updates/client/config.ts'
import { UpdateController } from '../../src/updates/client/controller.ts'
import {
  UpdatesSection,
  type UpdatesSectionProps,
} from '../../src/updates/client/UpdatesSection.tsx'
import { UpdateNotice } from '../../src/updates/client/UpdateNotice.tsx'
import { en, zh, UPDATE_NAMESPACE } from '../../src/updates/client/locales.ts'
import * as updates from '../../src/updates/client/index.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode
    variant?: string
    size?: string
  } & Record<string, unknown>) => createElement('button', { ...props, type: 'button' }, children),
  Switch: ({
    label,
    checked,
    disabled,
    onChange,
  }: {
    label: string
    checked: boolean
    disabled?: boolean
    onChange(next: boolean): void
  }) =>
    createElement('button', {
      type: 'button',
      role: 'switch',
      'aria-label': label,
      'aria-checked': checked,
      disabled,
      onClick: () => {
        if (!disabled) onChange(!checked)
      },
    }),
}))

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function status(overrides: Partial<OplUpdateStatus> = {}): OplUpdateStatus {
  return {
    installedVersion: '0.2.55',
    officialVersion: '0.2.2-rc.1',
    localCandidate: false,
    automatic: true,
    checking: false,
    preparing: false,
    checkedAt: null,
    lastSuccessAt: null,
    error: null,
    release: null,
    pendingVersion: null,
    ...overrides,
  }
}

function release(overrides: Partial<OplUpdateRelease> = {}): OplUpdateRelease {
  return {
    version: '0.2.56',
    officialVersion: '0.2.2-rc.1',
    url: 'https://github.com/gaofeng21cn/opl-dsh/releases/tag/v0.2.56',
    publishedAt: '2026-11-07T02:00:00.000Z',
    compatibility: 'enhancement',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish(next: T) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    listeners,
  }
}

function host(initial = status()) {
  const source = observable(initial)
  let current = initial
  const api = {
    status: vi.fn(async () => current),
    check: vi.fn(async () => current),
    setAutomatic: vi.fn(async (enabled: boolean) => {
      current = { ...current, automatic: enabled }
      return current
    }),
    prepare: vi.fn(async () => {
      current = { ...current, pendingVersion: current.release!.version }
      return current
    }),
    cancel: vi.fn(async () => {
      current = { ...current, preparing: false, pendingVersion: null }
      return current
    }),
    setPolicy: vi.fn(async (policy: OplUpdatePolicy) => {
      current = { ...current, policy }
      return current
    }),
    postpone: vi.fn(async () => {
      current = {
        ...current,
        restart: { phase: 'waiting' as const, dueAt: null, reason: null },
      }
      return current
    }),
    activity: vi.fn(async () => {}),
  } satisfies OplUpdateApi
  return {
    api,
    source,
    publish(next: OplUpdateStatus) {
      current = next
      source.publish(next)
    },
  }
}

function translator(dictionary: typeof en = zh): UpdatesSectionProps['t'] {
  return ((key: keyof typeof en, parameters?: Record<string, unknown>) =>
    dictionary[key].replace(/\{(\w+)\}/gu, (_match, name: string) =>
      String(parameters?.[name] ?? ''),
    )) as UpdatesSectionProps['t']
}
const t = translator()

async function mount(
  options: {
    initial?: OplUpdateStatus
    configure?: (api: ReturnType<typeof host>['api']) => void
    config?: Partial<Omit<Config, 'api'>>
    dictionary?: typeof en
  } = {},
) {
  const backend = host(options.initial)
  options.configure?.(backend.api)
  const openSettings = vi.fn()
  const controller = new UpdateController({
    api: backend.api,
    subscribe: backend.source.subscribe,
    openSettings,
    ...options.config,
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let mounted = true
  const unmount = async () => {
    if (!mounted) return
    mounted = false
    await act(async () => {
      controller.stop()
      root.unmount()
    })
  }
  cleanups.push(unmount)
  await act(async () => {
    controller.start()
    root.render(
      createElement(
        'div',
        null,
        createElement(UpdatesSection, { controller, t: translator(options.dictionary) }),
        createElement(UpdateNotice, {
          controller,
          wide: true,
          t: translator(options.dictionary),
          openSettings,
        }),
      ),
    )
  })
  return { ...backend, controller, container, root, openSettings, unmount }
}

function section(container: HTMLElement): HTMLElement {
  const panel = container.querySelector<HTMLElement>('[data-opl-panel="updates"]')
  expect(panel).not.toBeNull()
  return panel!
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...section(container).querySelectorAll('button')].filter(
    (node) => node.textContent === label,
  )
  expect(found, `button ${label}`).toHaveLength(1)
  return found[0]!
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click())
}

async function complete<T>(gate: ReturnType<typeof deferred<T>>, value: T): Promise<void> {
  await act(async () => gate.resolve(value))
}

function fakeTime() {
  vi.useFakeTimers()
  vi.setSystemTime('2026-11-07T04:00:00.000Z')
  cleanups.push(() => {
    vi.useRealTimers()
  })
}

function policy(overrides: Partial<OplUpdatePolicy> = {}): OplUpdatePolicy {
  return { mode: 'notify', idleMinutes: 5, countdownSeconds: 30, ...overrides }
}

function countdown(seconds = 30): OplUpdateStatus {
  return status({
    policy: policy({ mode: 'idle' }),
    pendingVersion: '0.2.56',
    restart: {
      phase: 'countdown',
      dueAt: new Date(Date.now() + seconds * 1000).toISOString(),
      reason: null,
    },
  })
}

async function selectMode(container: HTMLElement, mode: string): Promise<void> {
  const select = section(container).querySelector('select')!
  await act(async () => {
    select.value = mode
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function enterNumber(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function activityEvents() {
  const doc = vi.spyOn(document, 'addEventListener')
  const win = vi.spyOn(window, 'addEventListener')
  return {
    async trusted(type = 'pointerdown', target: EventTarget = document) {
      const calls = type === 'focus' ? win.mock.calls : doc.mock.calls
      const callback = [...calls].reverse().find(([name]) => name === type)?.[1]
      expect(typeof callback).toBe('function')
      // jsdom cannot synthesize trusted DOM input; invoke the installed browser listener directly.
      await act(async () => (callback as EventListener)({ type, target, isTrusted: true } as Event))
    },
  }
}

describe('unattended update preferences', () => {
  it('uses reminder defaults without changing the separate automatic-check preference', async () => {
    const f = await mount()
    const select = section(f.container).querySelector('select')!
    expect(select.value).toBe('notify')
    expect([...select.options].map((option) => option.value)).toEqual([
      'notify',
      'on-launch',
      'idle',
    ])
    expect(f.api.setPolicy).not.toHaveBeenCalled()
    await selectMode(f.container, 'on-launch')
    expect(f.api.setPolicy).toHaveBeenCalledExactlyOnceWith(policy({ mode: 'on-launch' }))
    expect(f.api.setAutomatic).not.toHaveBeenCalled()
    expect(f.api.prepare).not.toHaveBeenCalled()
    expect(select.value).toBe('on-launch')
    expect(f.container.textContent).toContain(zh.modeOnLaunchHelp)
  })

  it('keeps the accepted mode while saving and blocks duplicate or conflicting preferences', async () => {
    const gate = deferred<OplUpdateStatus>()
    const f = await mount({
      configure: (api) => api.setPolicy.mockImplementation(() => gate.promise),
    })
    await selectMode(f.container, 'idle')
    const select = section(f.container).querySelector('select')!
    expect(select.disabled).toBe(true)
    expect(select.value).toBe('notify')
    expect(f.container.textContent).toContain(zh.savingPolicy)
    await act(async () => {
      await f.controller.setPolicy(policy({ mode: 'on-launch' }))
      await f.controller.setAutomatic(false)
    })
    expect(f.api.setPolicy).toHaveBeenCalledExactlyOnceWith(policy({ mode: 'idle' }))
    expect(f.api.setAutomatic).not.toHaveBeenCalled()
    await complete(gate, status({ policy: policy({ mode: 'idle' }) }))
    expect(select.value).toBe('idle')
    expect(select.disabled).toBe(false)
  })

  it('requires a fresh read after an uncertain policy write and displays its accepted result', async () => {
    const f = await mount({
      configure(api) {
        api.setPolicy.mockRejectedValue(new Error('private-preference-path'))
      },
    })
    await selectMode(f.container, 'idle')
    expect(section(f.container).querySelector('select')!.value).toBe('notify')
    expect(section(f.container).querySelector('select')!.disabled).toBe(true)
    expect(f.container.textContent).toContain(zh['policy-failed'])
    expect(f.container.textContent).not.toContain('private-preference-path')
    await act(async () => f.controller.setPolicy(policy({ mode: 'idle' })))
    expect(f.api.setPolicy).toHaveBeenCalledTimes(1)
    f.api.status.mockResolvedValueOnce(status({ policy: policy({ mode: 'idle' }) }))
    await click(button(f.container, zh.refreshStatus))
    expect(section(f.container).querySelector('select')!.value).toBe('idle')
    expect(section(f.container).querySelector('select')!.disabled).toBe(false)
    expect(f.container.textContent).not.toContain(zh['policy-failed'])
  })

  it('validates editable timing ranges before saving both values together', async () => {
    const f = await mount({ initial: status({ policy: policy({ mode: 'idle' }) }) })
    const [idle, seconds] = [
      ...section(f.container).querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ]
    expect(idle!.value).toBe('5')
    expect(seconds!.value).toBe('30')
    for (const invalid of ['', '0', '121', '1.5']) {
      await enterNumber(idle!, invalid)
      expect(button(f.container, zh.saveTiming).disabled).toBe(true)
      expect(f.container.textContent).toContain(zh.timingRange)
    }
    await enterNumber(idle!, '1')
    for (const invalid of ['14', '301', '15.5']) {
      await enterNumber(seconds!, invalid)
      expect(button(f.container, zh.saveTiming).disabled).toBe(true)
    }
    expect(f.api.setPolicy).not.toHaveBeenCalled()
    await enterNumber(seconds!, '300')
    expect(button(f.container, zh.saveTiming).disabled).toBe(false)
    await click(button(f.container, zh.saveTiming))
    expect(f.api.setPolicy).toHaveBeenCalledExactlyOnceWith(
      policy({ mode: 'idle', idleMinutes: 1, countdownSeconds: 300 }),
    )
    expect(button(f.container, zh.saveTiming).disabled).toBe(true)
    expect(f.container.querySelector('input[aria-invalid="true"]')).toBeNull()
  })

  it('preserves unsaved timing edits across unrelated status events', async () => {
    const initial = status({ policy: policy({ mode: 'idle' }) })
    const f = await mount({ initial })
    const input = section(f.container).querySelector<HTMLInputElement>('input')!
    await enterNumber(input, '8')
    await act(async () => f.publish({ ...initial, release: release() }))
    expect(input.value).toBe('8')
    expect(f.api.setPolicy).not.toHaveBeenCalled()
  })

  it('ignores an old policy save after a new connection accepts different settings', async () => {
    const gate = deferred<OplUpdateStatus>()
    const connection = observable<number | undefined>(1)
    const f = await mount({
      config: { connection },
      configure: (api) => api.setPolicy.mockImplementation(() => gate.promise),
    })
    await selectMode(f.container, 'idle')
    await act(async () => {
      connection.publish(undefined)
      f.publish(status({ policy: policy({ mode: 'on-launch' }) }))
      connection.publish(2)
    })
    await complete(gate, status({ policy: policy({ mode: 'idle' }) }))
    expect(section(f.container).querySelector('select')!.value).toBe('on-launch')
    expect(f.controller.getSnapshot().uncertain).toBe(false)
  })

  it.each(['enhancement', 'full-suite'] as const)(
    'keeps candidate replacement explicit for a %s release under idle policy',
    async (compatibility) => {
      const f = await mount({
        initial: status({
          localCandidate: true,
          policy: policy({ mode: 'idle' }),
          release: release({ compatibility }),
        }),
      })
      expect(f.container.textContent).toContain(zh.localCandidate)
      expect(f.api.prepare).not.toHaveBeenCalled()
      expect(f.api.setPolicy).not.toHaveBeenCalled()
      if (compatibility === 'full-suite') expect(f.container.textContent).toContain(zh.fullSuite)
    },
  )
})

describe('restart countdown presentation', () => {
  it('renders the Host deadline in both places and stops its display clock at zero without polling', async () => {
    fakeTime()
    const f = await mount({ initial: countdown(7) })
    const notice = () => f.container.querySelector<HTMLElement>('[data-opl-update-notice]')!
    expect(notice().textContent).toContain('7')
    expect(notice().getAttribute('aria-label')).toContain('7 秒')
    expect(section(f.container).textContent).toContain('7 秒后')
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(notice().textContent).toContain('5')
    expect(section(f.container).textContent).toContain('5 秒后')
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(notice().textContent).toContain('0')
    expect(f.api.status).toHaveBeenCalledTimes(1)
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    expect(f.api.check).not.toHaveBeenCalled()
    expect(f.api.prepare).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('postpones once while retaining the prepared version and permits cancelling instead', async () => {
    const gate = deferred<OplUpdateStatus>()
    const initial = countdown()
    const f = await mount({
      initial,
      configure: (api) => api.postpone.mockImplementation(() => gate.promise),
    })
    await click(button(f.container, zh.postpone))
    await act(async () => f.controller.postpone())
    expect(f.api.postpone).toHaveBeenCalledTimes(1)
    expect(button(f.container, zh.postponing).disabled).toBe(true)
    const waiting = {
      ...initial,
      restart: { phase: 'waiting' as const, dueAt: null, reason: null },
    }
    await complete(gate, waiting)
    expect(f.container.querySelector('[data-opl-update-pending]')).not.toBeNull()
    expect(section(f.container).textContent).toContain(
      zh.restartWaiting.replace('{version}', '0.2.56'),
    )
    await click(button(f.container, zh.cancel))
    expect(f.api.cancel).toHaveBeenCalledTimes(1)
    expect(f.container.querySelector('[data-opl-update-pending]')).toBeNull()
  })

  it('offers the same postpone action in the wide sidebar and a compact countdown when collapsed', async () => {
    const f = await mount({ initial: countdown(), dictionary: en })
    const footer = f.container.querySelector('[data-opl-update-notice]')!.parentElement!
    const postpone = [...footer.querySelectorAll('button')].find(
      (node) => node.textContent === en.postpone,
    )!
    expect(postpone).toBeDefined()
    await click(postpone)
    expect(f.api.postpone).toHaveBeenCalledTimes(1)
    await act(async () => {
      f.publish(countdown(17))
      f.root.render(
        createElement(UpdateNotice, { controller: f.controller, t: translator(en), wide: false }),
      )
    })
    expect(f.container.textContent).toBe('17s')
    expect(
      f.container.querySelector('[data-opl-update-notice]')!.getAttribute('aria-label'),
    ).toContain('17 seconds')
  })

  it('preempts a slow status read with postponement and ignores its old countdown result', async () => {
    const initial = countdown()
    const f = await mount({ initial })
    const gate = deferred<OplUpdateStatus>()
    f.api.status.mockImplementationOnce(() => gate.promise)
    await act(async () => f.publish(initial))
    expect(f.controller.getSnapshot().operation).toBe('status')
    expect(button(f.container, zh.postpone).disabled).toBe(false)
    await click(button(f.container, zh.postpone))
    expect(f.controller.getSnapshot().status?.restart?.phase).toBe('waiting')
    await complete(gate, initial)
    expect(f.controller.getSnapshot().status?.restart?.phase).toBe('waiting')
  })

  it('marks a lost postpone response uncertain and requires confirmation before repeating it', async () => {
    const f = await mount({
      initial: countdown(),
      configure: (api) => api.postpone.mockRejectedValue(new Error('private-restart-details')),
    })
    await click(button(f.container, zh.postpone))
    expect(f.container.textContent).toContain(zh['postpone-failed'])
    expect(f.container.textContent).not.toContain('private-restart-details')
    expect(button(f.container, zh.postpone).disabled).toBe(true)
    expect(button(f.container, zh.cancel).disabled).toBe(true)
    expect(
      f.container.querySelector('[data-opl-update-notice]')!.getAttribute('aria-label'),
    ).toContain(zh.noticeStale)
    await click(button(f.container, zh.refreshStatus))
    expect(button(f.container, zh.postpone).disabled).toBe(false)
  })

  it('withdraws the countdown on disconnect and waits for the new generation to confirm it', async () => {
    fakeTime()
    const connection = observable<number | undefined>(1)
    const f = await mount({ initial: countdown(), config: { connection } })
    expect(vi.getTimerCount()).toBe(2)
    await act(async () => connection.publish(undefined))
    expect(vi.getTimerCount()).toBe(0)
    const gate = deferred<OplUpdateStatus>()
    f.api.status.mockImplementationOnce(() => gate.promise)
    await act(async () => connection.publish(2))
    expect(f.container.textContent).not.toContain('30 秒后')
    expect(button(f.container, zh.postpone).disabled).toBe(true)
    await complete(gate, countdown(8))
    expect(f.container.textContent).toContain('8 秒后')
    expect(button(f.container, zh.postpone).disabled).toBe(false)
  })

  it.each([
    'busy',
    'activity-unknown',
    'other-profile',
    'desktop-unavailable',
    'update-failed',
  ] as const)('explains the Host waiting reason %s through the selected locale', async (reason) => {
    const f = await mount({
      dictionary: en,
      initial: status({
        pendingVersion: '0.2.56',
        restart: { phase: reason === 'update-failed' ? 'failed' : 'waiting', dueAt: null, reason },
      }),
    })
    expect(section(f.container).textContent).toContain(en[reason])
    expect(f.api.postpone).not.toHaveBeenCalled()
  })

  it('shows handoff without offering writes after the Host begins restarting', async () => {
    const initial = countdown()
    const f = await mount({
      initial: { ...initial, restart: { phase: 'handoff', dueAt: null, reason: null } },
    })
    expect(f.container.textContent).toContain(zh.restartHandoff.replace('{version}', '0.2.56'))
    expect(section(f.container).querySelector('select')!.disabled).toBe(true)
    expect(button(f.container, zh.check).disabled).toBe(true)
    expect(
      [...section(f.container).querySelectorAll('button')].map((node) => node.textContent),
    ).not.toContain(zh.cancel)
    await act(async () => {
      await f.controller.postpone()
      await f.controller.cancel()
      await f.controller.setPolicy(policy())
    })
    expect(f.api.postpone).not.toHaveBeenCalled()
    expect(f.api.cancel).not.toHaveBeenCalled()
    expect(f.api.setPolicy).not.toHaveBeenCalled()
  })
})

describe('update activity reporting', () => {
  it('reports a ready renderer once, including hidden windows, without a foreground heartbeat or status polling', async () => {
    fakeTime()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const connection = observable<number | undefined>(undefined)
    const f = await mount({ config: { connection } })
    expect(f.api.activity).not.toHaveBeenCalled()
    await act(async () => connection.publish(1))
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    expect(f.api.status).toHaveBeenCalledTimes(1)
    expect(f.api.check).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores synthetic input and coalesces trusted interaction into one trailing report per ten seconds', async () => {
    fakeTime()
    const events = activityEvents()
    const f = await mount()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
      document.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    await events.trusted()
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 20; i++) await events.trusted('keydown')
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => vi.advanceTimersByTimeAsync(9999))
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(f.api.activity).toHaveBeenCalledTimes(3)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(f.api.activity).toHaveBeenCalledTimes(3)
    expect(f.api.status).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for one activity RPC before sending a coalesced newer interaction', async () => {
    fakeTime()
    const events = activityEvents()
    const gate = deferred<void>()
    const f = await mount({
      configure: (api) => api.activity.mockImplementationOnce(() => gate.promise),
    })
    await events.trusted('input')
    await events.trusted('wheel')
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    await complete(gate, undefined)
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    expect(f.api.status).toHaveBeenCalledTimes(1)
    expect(f.controller.getSnapshot().uncertain).toBe(false)
  })

  it('keeps settings confirmed after an activity failure and retries only after newer interaction', async () => {
    fakeTime()
    const events = activityEvents()
    const f = await mount({
      configure: (api) => api.activity.mockRejectedValueOnce(new Error('private-activity-detail')),
    })
    expect(f.controller.getSnapshot().failure).toBeNull()
    expect(f.controller.getSnapshot().uncertain).toBe(false)
    expect(section(f.container).querySelector('select')!.disabled).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    await events.trusted()
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    expect(f.api.status).toHaveBeenCalledTimes(1)
    expect(f.container.textContent).not.toContain('private-activity-detail')
  })

  it('reports the first trusted input during a countdown immediately, ahead of an existing throttle timer', async () => {
    fakeTime()
    const events = activityEvents()
    const f = await mount()
    await events.trusted()
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => f.publish(countdown()))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    await events.trusted('keydown')
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    expect(f.api.status).toHaveBeenCalledTimes(2)
    expect(f.api.postpone).not.toHaveBeenCalled()
    for (let i = 0; i < 10; i++) await events.trusted('input')
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    const waiting = {
      ...f.controller.getSnapshot().status!,
      restart: { phase: 'waiting' as const, dueAt: null, reason: null },
    }
    await act(async () => f.publish(waiting))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(f.api.activity).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports trusted foreground changes and ignores input focus or interaction while hidden', async () => {
    fakeTime()
    const events = activityEvents()
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const f = await mount()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    await events.trusted()
    await events.trusted('visibilitychange')
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    visible.mockReturnValue('visible')
    await events.trusted('focus', document.createElement('input'))
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    await events.trusted('focus', window)
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    await events.trusted('visibilitychange')
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(f.api.activity).toHaveBeenCalledTimes(3)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(f.api.activity).toHaveBeenCalledTimes(3)
  })

  it('keeps a newer generation in flight when an old activity request resolves', async () => {
    fakeTime()
    const events = activityEvents()
    const old = deferred<void>()
    const current = deferred<void>()
    const connection = observable<number | undefined>(1)
    const f = await mount({
      config: { connection },
      configure: (api) =>
        api.activity
          .mockImplementationOnce(() => old.promise)
          .mockImplementationOnce(() => current.promise),
    })
    await events.trusted()
    await act(async () => {
      connection.publish(undefined)
      connection.publish(2)
    })
    await events.trusted('keydown')
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    await complete(old, undefined)
    expect(f.api.activity).toHaveBeenCalledTimes(2)
    await complete(current, undefined)
    expect(f.api.activity).toHaveBeenCalledTimes(3)
    expect(f.api.status).toHaveBeenCalledTimes(2)
  })

  it('clears queued reports and listeners on disposal and ignores a late failed activity RPC', async () => {
    fakeTime()
    const events = activityEvents()
    const gate = deferred<void>()
    const removed = vi.spyOn(document, 'removeEventListener')
    const f = await mount({
      configure: (api) => api.activity.mockImplementationOnce(() => gate.promise),
    })
    await events.trusted()
    await f.unmount()
    expect(removed.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining(['pointerdown', 'keydown', 'input', 'wheel', 'visibilitychange']),
    )
    await events.trusted('input')
    await act(async () => gate.reject(new Error('late-private-rpc-detail')))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    expect(f.controller.getSnapshot().connected).toBe(false)
    expect(f.controller.getSnapshot().failure).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops activity and status work on page exit, including an armed trailing report', async () => {
    fakeTime()
    const events = activityEvents()
    const connection = observable<number | undefined>(1)
    const f = await mount({ config: { connection } })
    await events.trusted()
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(connection.listeners.size).toBe(0)
    expect(f.source.listeners.size).toBe(0)
    expect(f.controller.getSnapshot().connected).toBe(false)
    await events.trusted()
    await act(async () => {
      f.publish(status())
      connection.publish(2)
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(f.api.activity).toHaveBeenCalledTimes(1)
    expect(f.api.status).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('update controls', () => {
  it('reads installed versions and the accepted automatic preference without checking or preparing', async () => {
    const f = await mount()
    expect(f.container.textContent).toContain('0.2.55')
    expect(f.container.textContent).toContain('0.2.2-rc.1')
    expect(f.container.textContent).toContain(zh.neverChecked)
    expect(f.container.textContent).not.toContain(zh.noUpdate)
    expect(f.container.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(f.api.status).toHaveBeenCalledTimes(1)
    expect(f.api.check).not.toHaveBeenCalled()
    expect(f.api.prepare).not.toHaveBeenCalled()
    expect(f.source.listeners.size).toBe(1)
    expect(f.container.querySelector('[data-opl-update-notice]')).toBeNull()
  })

  it('renders English controls from the same typed dictionary', async () => {
    const f = await mount({ dictionary: en, initial: status({ release: release() }) })
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(button(f.container, en.check)).toBeDefined()
    expect(button(f.container, en.prepare)).toBeDefined()
    expect(f.container.textContent).toContain(en.releaseNotes)
    expect(f.container.textContent).not.toContain(zh.automaticHelp)
  })

  it('saves the automatic-check switch once and waits for the accepted preference', async () => {
    const pending = deferred<OplUpdateStatus>()
    const f = await mount({
      configure(api) {
        api.setAutomatic.mockImplementation(() => pending.promise)
      },
    })
    const toggle = f.container.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => {
      toggle.click()
      toggle.click()
    })
    expect(f.api.setAutomatic).toHaveBeenCalledExactlyOnceWith(false)
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await complete(pending, status({ automatic: false }))
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('shows a failed preference save without exposing its exception or resending it', async () => {
    const f = await mount({
      configure(api) {
        api.setAutomatic.mockRejectedValue(new Error('private-local-path'))
      },
    })
    const toggle = f.container.querySelector<HTMLButtonElement>('[role="switch"]')!
    await click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.disabled).toBe(true)
    expect(f.container.textContent).toContain(zh['automatic-failed'])
    expect(f.container.textContent).not.toContain('private-local-path')
    await click(toggle)
    expect(f.api.setAutomatic).toHaveBeenCalledTimes(1)
    await click(button(f.container, zh.check))
    expect(toggle.disabled).toBe(false)
  })

  it('shows successful check time and the scope of a no-update result', async () => {
    const at = '2026-11-07T03:00:00.000Z'
    const f = await mount({
      configure(api) {
        api.check.mockResolvedValue(status({ checkedAt: at, lastSuccessAt: at }))
      },
    })
    await click(button(f.container, zh.check))
    expect(f.api.check).toHaveBeenCalledTimes(1)
    expect(f.container.textContent).toContain(zh.noUpdate)
    expect(f.container.querySelector('time')!.dateTime).toBe(at)
  })

  it('prepares an enhancement only on explicit choice and allows cancelling it', async () => {
    const offer = release()
    const f = await mount({ initial: status({ release: offer }) })
    expect(f.api.prepare).not.toHaveBeenCalled()
    const notes = section(f.container).querySelector<HTMLAnchorElement>('a')!
    expect(notes.href).toBe(offer.url)
    expect(notes.rel).toBe('noopener noreferrer')
    expect(notes.target).toBe('_blank')
    await click(button(f.container, zh.prepare))
    expect(f.api.prepare).toHaveBeenCalledTimes(1)
    expect(
      f.container
        .querySelector('[data-opl-update-pending]')!
        .getAttribute('data-opl-update-pending'),
    ).toBe(offer.version)
    expect(f.container.textContent).toContain(zh.pending.replace('{version}', offer.version))
    expect(f.container.textContent).toContain(zh.automaticHelp)
    await click(button(f.container, zh.cancel))
    expect(f.api.cancel).toHaveBeenCalledTimes(1)
    expect(f.container.querySelector('[data-opl-update-pending]')).toBeNull()
    expect(button(f.container, zh.prepare).disabled).toBe(false)
  })

  it('routes incompatible releases to the full suite without offering preparation', async () => {
    const offer = release({ compatibility: 'full-suite', officialVersion: '0.2.3' })
    const f = await mount({ initial: status({ release: offer }) })
    expect(f.container.textContent).toContain(zh.fullSuite)
    expect(f.container.textContent).toContain(zh.releaseOfficialVersion)
    expect(f.container.textContent).toContain('0.2.3')
    const download = [...section(f.container).querySelectorAll('a')].find(
      (node) => node.textContent === zh.download,
    )!
    expect(download.href).toBe(offer.url)
    expect(
      [...section(f.container).querySelectorAll('button')].map((node) => node.textContent),
    ).not.toContain(zh.prepare)
    await act(async () => f.controller.prepare())
    expect(f.api.prepare).not.toHaveBeenCalled()
  })

  it('identifies a local candidate and permits only explicit release preparation', async () => {
    const f = await mount({
      initial: status({
        localCandidate: true,
        installedVersion: '0.2.57-candidate',
        release: release(),
      }),
    })
    expect(f.container.textContent).toContain(zh.localCandidate)
    expect(f.api.prepare).not.toHaveBeenCalled()
    expect(f.container.textContent).not.toContain(zh.noUpdate)
    await click(button(f.container, zh.prepare))
    expect(f.api.prepare).toHaveBeenCalledTimes(1)
  })

  it('does not call a candidate build current when no release is offered', async () => {
    const at = '2026-11-07T03:00:00.000Z'
    const f = await mount({
      initial: status({ localCandidate: true, checkedAt: at, lastSuccessAt: at }),
    })
    expect(f.container.textContent).toContain(zh.localCandidate)
    expect(f.container.textContent).not.toContain(zh.noUpdate)
  })

  it('retains the known release and last successful time after a Host check failure', async () => {
    const offer = release()
    const success = '2026-11-06T03:00:00.000Z'
    const failed = '2026-11-07T03:00:00.000Z'
    const f = await mount({
      initial: status({ release: offer, checkedAt: success, lastSuccessAt: success }),
      configure(api) {
        api.check.mockResolvedValue(
          status({
            release: offer,
            checkedAt: failed,
            lastSuccessAt: success,
            error: 'check-failed',
          }),
        )
      },
    })
    await click(button(f.container, zh.check))
    expect(f.container.textContent).toContain(zh['check-failed'])
    expect(f.container.textContent).toContain(zh.lastSuccess)
    expect(f.container.querySelector(`[data-opl-update-release="${offer.version}"]`)).not.toBeNull()
    expect(f.container.querySelector('[data-opl-update-notice]')).not.toBeNull()
    expect(f.container.textContent).not.toContain(zh.noUpdate)
    expect([...f.container.querySelectorAll('time')].map((node) => node.dateTime)).toContain(
      success,
    )
  })

  it('retains the offer after a rejected check and never claims a successful check', async () => {
    const f = await mount({
      initial: status({ release: release() }),
      configure(api) {
        api.check.mockRejectedValue(new Error('private-network-detail'))
      },
    })
    await click(button(f.container, zh.check))
    expect(f.container.textContent).toContain(zh['check-failed'])
    expect(f.container.querySelector('[data-opl-update-release]')).not.toBeNull()
    expect(f.container.textContent).not.toContain(zh.noUpdate)
    expect(f.container.textContent).not.toContain('private-network-detail')
  })

  it.each(['host', 'transport'] as const)(
    'withdraws a previous no-update message after a %s check failure',
    async (failure) => {
      const lastSuccessAt = '2026-11-06T03:00:00.000Z'
      const known = status({ checkedAt: lastSuccessAt, lastSuccessAt })
      const f = await mount({
        initial: known,
        configure(api) {
          if (failure === 'transport') api.check.mockRejectedValue(new Error('offline'))
          else
            api.check.mockResolvedValue({
              ...known,
              checkedAt: '2026-11-07T03:00:00.000Z',
              error: 'check-failed',
            })
        },
      })
      expect(f.container.textContent).toContain(zh.noUpdate)
      await click(button(f.container, zh.check))
      expect(f.container.textContent).toContain(zh['check-failed'])
      expect(f.container.textContent).not.toContain(zh.noUpdate)
    },
  )

  it('keeps an offered release after the Host reports a preparation failure', async () => {
    const f = await mount({
      initial: status({ release: release() }),
      configure(api) {
        api.prepare.mockResolvedValue(status({ release: release(), error: 'prepare-failed' }))
      },
    })
    await click(button(f.container, zh.prepare))
    expect(f.container.textContent).toContain(zh['prepare-failed'])
    expect(f.container.querySelector('[data-opl-update-release]')).not.toBeNull()
    expect(f.container.querySelector('[data-opl-update-pending]')).toBeNull()
  })

  it('keeps a failed preparation unconfirmed until a fresh check, without scheduling it', async () => {
    const f = await mount({
      initial: status({ release: release() }),
      configure(api) {
        api.prepare.mockRejectedValue(new Error('private-download-directory'))
      },
    })
    await click(button(f.container, zh.prepare))
    expect(f.container.textContent).toContain(zh['prepare-failed'])
    expect(f.container.querySelector('[data-opl-update-pending]')).toBeNull()
    expect(button(f.container, zh.prepare).disabled).toBe(true)
    await click(button(f.container, zh.prepare))
    expect(f.api.prepare).toHaveBeenCalledTimes(1)
    expect(f.container.textContent).not.toContain('private-download-directory')
    await click(button(f.container, zh.check))
    expect(button(f.container, zh.prepare).disabled).toBe(false)
  })

  it('preserves a prepared update when cancellation fails and allows confirmation by checking', async () => {
    const f = await mount({
      initial: status({ pendingVersion: '0.2.56', release: release() }),
      configure(api) {
        api.cancel.mockRejectedValueOnce(new Error('cancel result lost'))
      },
    })
    await click(button(f.container, zh.cancel))
    expect(f.container.textContent).toContain(zh['cancel-failed'])
    expect(f.container.querySelector('[data-opl-update-pending]')).not.toBeNull()
    expect(button(f.container, zh.cancel).disabled).toBe(true)
    await click(button(f.container, zh.check))
    await click(button(f.container, zh.cancel))
    expect(f.api.cancel).toHaveBeenCalledTimes(2)
    expect(f.container.querySelector('[data-opl-update-pending]')).toBeNull()
  })

  it('blocks duplicate checks and all writes while a check is unresolved', async () => {
    const gate = deferred<OplUpdateStatus>()
    const f = await mount({
      initial: status({ release: release() }),
      configure(api) {
        api.check.mockImplementation(() => gate.promise)
      },
    })
    const check = button(f.container, zh.check)
    await act(async () => {
      check.click()
      check.click()
      await f.controller.check()
    })
    expect(f.api.check).toHaveBeenCalledTimes(1)
    expect(check.disabled).toBe(true)
    expect(f.container.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true)
    expect(button(f.container, zh.prepare).disabled).toBe(true)
    await complete(gate, status({ release: release() }))
    expect(button(f.container, zh.check).disabled).toBe(false)
  })

  it('shows Host download progress and waits for a status event to enable actions', async () => {
    const f = await mount({ initial: status({ release: release(), preparing: true }) })
    expect(f.container.textContent).toContain(zh.preparing)
    expect(button(f.container, zh.check).disabled).toBe(true)
    expect(button(f.container, zh.preparing).disabled).toBe(true)
    await act(async () => f.publish(status({ release: release(), pendingVersion: '0.2.56' })))
    expect(button(f.container, zh.cancel).disabled).toBe(false)
    expect(f.api.check).not.toHaveBeenCalled()
  })

  it('cancels an active prepare request and ignores its late completion', async () => {
    const prepareGate = deferred<OplUpdateStatus>()
    const cancelGate = deferred<OplUpdateStatus>()
    const f = await mount({
      initial: status({ release: release() }),
      configure(api) {
        api.prepare.mockImplementation(() => prepareGate.promise)
        api.cancel.mockImplementation(() => cancelGate.promise)
      },
    })
    await click(button(f.container, zh.prepare))
    expect(button(f.container, zh.cancelDownload).disabled).toBe(false)
    await click(button(f.container, zh.cancelDownload))
    await act(async () => {
      await f.controller.cancel()
      await f.controller.prepare()
    })
    expect(f.api.cancel).toHaveBeenCalledTimes(1)
    expect(f.api.prepare).toHaveBeenCalledTimes(1)
    await complete(cancelGate, status({ release: release() }))
    await complete(prepareGate, status({ release: release(), pendingVersion: '0.2.56' }))
    expect(f.container.querySelector('[data-opl-update-pending]')).toBeNull()
    expect(button(f.container, zh.prepare).disabled).toBe(false)
  })

  it('cancels a Host download discovered in the initial status', async () => {
    const f = await mount({ initial: status({ release: release(), preparing: true }) })
    await click(button(f.container, zh.cancelDownload))
    expect(f.api.cancel).toHaveBeenCalledTimes(1)
    expect(f.api.prepare).not.toHaveBeenCalled()
    expect(f.container.querySelector('[data-opl-update-pending]')).toBeNull()
    expect(button(f.container, zh.prepare).disabled).toBe(false)
  })

  it('can reread status after a failed cancellation while the Host is still downloading', async () => {
    const f = await mount({
      initial: status({ release: release(), preparing: true }),
      configure(api) {
        api.cancel.mockRejectedValueOnce(new Error('cancel transport lost'))
      },
    })
    await click(button(f.container, zh.cancelDownload))
    expect(button(f.container, zh.check).disabled).toBe(true)
    expect(button(f.container, zh.cancelDownload).disabled).toBe(true)
    expect(button(f.container, zh.refreshStatus).disabled).toBe(false)
    await click(button(f.container, zh.refreshStatus))
    expect(f.api.status).toHaveBeenCalledTimes(2)
    expect(button(f.container, zh.cancelDownload).disabled).toBe(false)
    await click(button(f.container, zh.cancelDownload))
    expect(f.api.cancel).toHaveBeenCalledTimes(2)
    expect(button(f.container, zh.prepare).disabled).toBe(false)
  })

  it('allows an explicit check to recover a failed initial status read', async () => {
    const f = await mount({
      configure(api) {
        api.status.mockRejectedValue(new Error('unavailable'))
      },
    })
    expect(f.container.textContent).toContain(zh['status-failed'])
    expect(button(f.container, zh.check).disabled).toBe(false)
    await click(button(f.container, zh.check))
    expect(f.container.textContent).toContain('0.2.55')
    expect(f.container.textContent).not.toContain(zh['status-failed'])
  })
})

describe('update subscriptions and request lifetimes', () => {
  it('coalesces changes during a slow read and replaces its old offer with the current Host status', async () => {
    const gate = deferred<OplUpdateStatus>()
    const f = await mount({
      configure(api) {
        api.status.mockImplementationOnce(() => gate.promise)
      },
    })
    const next = status({ release: release({ version: '0.2.58' }) })
    await act(async () => {
      for (let i = 0; i < 20; i++) f.publish(next)
    })
    expect(f.api.status).toHaveBeenCalledTimes(1)
    await complete(gate, status({ release: release() }))
    expect(f.api.status).toHaveBeenCalledTimes(2)
    expect(f.controller.getSnapshot().status?.release?.version).toBe('0.2.58')
    expect(f.container.querySelectorAll('[data-opl-update-notice]')).toHaveLength(1)
    expect(f.source.listeners.size).toBe(1)
    expect(f.api.check).not.toHaveBeenCalled()
  })

  it('waits for a connection generation before the first request', async () => {
    const connection = observable<number | undefined>(undefined)
    const f = await mount({ config: { connection } })
    expect(f.api.status).not.toHaveBeenCalled()
    expect(button(f.container, zh.check).disabled).toBe(true)
    await act(async () => connection.publish(1))
    expect(f.api.status).toHaveBeenCalledTimes(1)
    expect(button(f.container, zh.check).disabled).toBe(false)
  })

  it('ignores a late old-generation status after reconnecting', async () => {
    const gate = deferred<OplUpdateStatus>()
    const connection = observable<number | undefined>(1)
    const f = await mount({
      config: { connection },
      configure(api) {
        api.status.mockImplementationOnce(() => gate.promise)
      },
    })
    await act(async () => connection.publish(undefined))
    expect(button(f.container, zh.check).disabled).toBe(true)
    const next = status({ installedVersion: '0.2.58' })
    await act(async () => {
      f.publish(next)
      connection.publish(2)
    })
    expect(f.controller.getSnapshot().status?.installedVersion).toBe('0.2.58')
    await complete(gate, status({ installedVersion: '0.2.54' }))
    expect(f.container.textContent).toContain('0.2.58')
    expect(f.container.textContent).not.toContain('0.2.54')
  })

  it('ignores an old prepare result after connection loss and rereads the new generation', async () => {
    const gate = deferred<OplUpdateStatus>()
    const connection = observable<number | undefined>(1)
    const f = await mount({
      initial: status({ release: release() }),
      config: { connection },
      configure(api) {
        api.prepare.mockImplementation(() => gate.promise)
      },
    })
    await click(button(f.container, zh.prepare))
    await act(async () => connection.publish(undefined))
    expect(f.container.textContent).toContain(zh.disconnected)
    await act(async () => {
      f.publish(status({ installedVersion: '0.2.57' }))
      connection.publish(2)
    })
    await complete(gate, status({ release: release(), pendingVersion: '0.2.56' }))
    expect(f.container.querySelector('[data-opl-update-pending]')).toBeNull()
    expect(f.container.textContent).toContain('0.2.57')
    expect(f.api.prepare).toHaveBeenCalledTimes(1)
  })

  it('disposes observers and ignores a slow answer after unmount', async () => {
    const gate = deferred<OplUpdateStatus>()
    const connection = observable<number | undefined>(1)
    const f = await mount({
      config: { connection },
      configure(api) {
        api.status.mockImplementationOnce(() => gate.promise)
      },
    })
    await f.unmount()
    expect(connection.listeners.size).toBe(0)
    expect(f.source.listeners.size).toBe(0)
    await complete(gate, status({ release: release() }))
    expect(f.controller.getSnapshot().status).toBeNull()
    await act(async () => {
      f.publish(status())
      connection.publish(2)
    })
    expect(f.api.status).toHaveBeenCalledTimes(1)
  })

  it('renders one persistent notice for repeated observations and opens existing settings', async () => {
    const offer = status({ release: release() })
    const f = await mount({ initial: offer })
    for (let i = 0; i < 3; i++) await act(async () => f.publish({ ...offer }))
    const notices = f.container.querySelectorAll<HTMLButtonElement>('[data-opl-update-notice]')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.getAttribute('aria-label')).toContain('0.2.56')
    await click(notices[0]!)
    expect(f.openSettings).toHaveBeenCalledTimes(1)
    expect(f.api.prepare).not.toHaveBeenCalled()
  })

  it('uses a release link without navigation injection and labels a pending collapsed notice', async () => {
    const f = await mount({ initial: status({ release: release() }) })
    await act(async () =>
      f.root.render(createElement(UpdateNotice, { controller: f.controller, t, wide: false })),
    )
    const link = f.container.querySelector<HTMLAnchorElement>('a')!
    expect(link.href).toBe(release().url)
    expect(link.getAttribute('aria-label')).toContain('0.2.56')
    await act(async () => f.publish(status({ pendingVersion: '0.2.56' })))
    expect(f.container.querySelector('a')).toBeNull()
    expect(f.container.querySelector('[data-opl-update-notice]')!.getAttribute('aria-label')).toBe(
      zh.noticePending.replace('{version}', '0.2.56'),
    )
  })
})

describe('update plugin lifecycle', () => {
  it('registers only additive official slots and cleans up a replaced plugin fiber', async () => {
    type Entry = {
      name: string
      id?: string
      inject?: () => { controller: UpdateController }
      component: ComponentType
    }
    const entries: Entry[] = []
    class Slots extends Service {
      constructor(ctx: Context) {
        super(ctx, 'slots')
      }
      inject(_name: string, mount: () => unknown) {
        return mount()
      }
      register(options: Omit<Entry, 'component'>, component: ComponentType) {
        const entry = { ...options, component }
        entries.push(entry)
        return this.ctx.effect(() => () => {
          entries.splice(entries.indexOf(entry), 1)
        })
      }
    }
    class Locale extends Service {
      register = vi.fn(() => vi.fn())
      constructor(ctx: Context) {
        super(ctx, 'locale')
      }
    }
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    let locale!: Locale
    await ctx.plugin({
      name: 'update-services',
      apply(provider: Context) {
        new Slots(provider)
        locale = new Locale(provider)
      },
    })
    const oldGate = deferred<OplUpdateStatus>()
    const old = host()
    old.api.status.mockImplementation(() => oldGate.promise)
    const first = await ctx.plugin(updates, { api: old.api, subscribe: old.source.subscribe })
    expect(updates.inject).toEqual(['slots', 'locale'])
    expect('default' in updates).toBe(false)
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'settings.general.item',
      'sidebar.footer.action',
    ])
    expect(locale.register).toHaveBeenCalledWith(UPDATE_NAMESPACE, { zh, en })
    const controller = entries[0]!.inject!().controller
    await first.dispose()
    expect(entries).toHaveLength(0)
    expect(old.source.listeners.size).toBe(0)
    expect(locale.register.mock.results[0]!.value).toHaveBeenCalledTimes(1)
    const replacement = host(status({ installedVersion: '0.2.57' }))
    await ctx.plugin(updates, { api: replacement.api, subscribe: replacement.source.subscribe })
    oldGate.resolve(status({ installedVersion: '0.2.54' }))
    await oldGate.promise
    expect(controller.getSnapshot().status).toBeNull()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.inject!().controller.getSnapshot().status?.installedVersion).toBe('0.2.57')
  })
})
