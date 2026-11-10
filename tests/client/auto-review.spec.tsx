/**
 * Auto Review settings section — component, store, and plugin tests.
 *
 * Nothing here touches a real credential, model, Remote, or Host: the only
 * dependency of the section is the injected `read`/`save` seam, and every case
 * drives it with a local promise. Coverage pins the product decisions a user
 * must be able to rely on: the section is off by default, enabling writes
 * nothing until the explicit Save, no Session permission service is reached at
 * all, a rejected disable never renders as off first, a stale draft must be
 * re-read, a dirty draft survives a read, advertised efforts are exact, and a
 * late answer from a previous Host generation or after unmount never fills the
 * panel back in.
 */
import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { ReactNode } from 'react'
import type { AutoReviewSectionProps } from '../../src/auto-review/client/AutoReviewSection.tsx'
import { AUTO_REVIEW_BUDGET_RANGE } from '../../src/auto-review/contracts/settings.ts'
import type {
  AutoReviewClientApi,
  AutoReviewConnectionSource,
  AutoReviewPreferences,
  AutoReviewRouteOption,
  AutoReviewSaveRequest,
  AutoReviewSaveResult,
  AutoReviewStatus,
} from '../../src/auto-review/contracts/settings.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  // The published primitives package is not loadable from this offline install,
  // so the two atoms this section uses are stood in for with faithful, minimal
  // React elements that keep the props the section relies on observable.
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    React.createElement('button', { ...props, type: 'button' }, children),
  Switch: ({
    label,
    checked,
    disabled,
    onChange,
    ...props
  }: {
    label: string
    checked: boolean
    disabled?: boolean
    onChange: (next: boolean) => void
  } & Record<string, unknown>) =>
    React.createElement(
      'button',
      {
        ...props,
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        disabled,
        onClick: () => {
          if (!disabled) onChange(!checked)
        },
      },
      label,
    ),
}))

// `./dom.ts` installs the process DOM on import, before React DOM is loaded.
const dom = createTestDom()
completeDom()
const { AutoReviewSection, serviceReady, disabledReasonKey, saveBlockedReasonKey } =
  await import('../../src/auto-review/client/AutoReviewSection.tsx')
const { AutoReviewSettingsStore, effectivePreferences } =
  await import('../../src/auto-review/client/controller.ts')
const { AUTO_REVIEW_NAMESPACE, en, zh } = await import('../../src/auto-review/client/locales.ts')
const { advertisedEffort, budgetIsSubmittable, withFixedEffort, withFixedRoute, routeKey } =
  await import('../../src/auto-review/client/preferences.ts')
const { REVIEW_BUDGET_RANGE } = await import('../../src/auto-review/client/config.ts')
const { apply, inject } = await import('../../src/auto-review/client/index.tsx')
const { createRoot } = await import('react-dom/client')

type ShimNode = {
  nodeName: string
  textContent: string | null
  childNodes?: ShimNode[]
  parentNode?: ShimNode | null
  value?: string
  checked?: boolean
  disabled?: boolean
  selected?: boolean
  click?: () => boolean
  dispatchEvent?: (type: string) => boolean
  getAttribute?: (name: string) => string | null
  style?: Record<string, string>
}

/**
 * Complete the shared DOM shim with the four things this section needs: bubbling
 * listeners so a click reaches React's delegated root handler, a `type` getter
 * React reads to identify radios, a `value` property so a typed budget or a
 * chosen select option can be read back, and the `options` collection React
 * walks for a select. Only elements created by the process DOM are touched.
 */
function completeDom(): { dispatch: (target: object, type: string) => boolean } {
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
  const fire = (type: string, target: object): boolean => {
    const event = {
      type,
      target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      timeStamp: 0,
      eventPhase: 2,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    }
    let node = target as { parentNode?: object | null } | null
    while (node) {
      for (const listener of [...(listeners.get(node)?.get(type) ?? [])]) listener(event)
      node = node.parentNode ?? null
    }
    return true
  }
  proto['dispatchEvent'] = function (type: string) {
    return fire(type, this)
  }
  proto['click'] = function () {
    return fire('click', this)
  }
  Object.defineProperty(proto, 'type', {
    get(this: ShimNode) {
      return this.getAttribute?.('type') ?? ''
    },
    set(this: ShimNode, next: unknown) {
      this.setAttribute?.('type', String(next))
    },
    configurable: true,
  })
  Object.defineProperty(proto, 'disabled', {
    get(this: ShimNode) {
      return this.getAttribute?.('disabled') !== null
    },
    set(this: ShimNode, next: unknown) {
      if (next) this.setAttribute?.('disabled', '')
      else
        (this as unknown as { removeAttribute?: (name: string) => void }).removeAttribute?.(
          'disabled',
        )
    },
    configurable: true,
  })
  const values = new WeakMap<object, string>()
  Object.defineProperty(proto, 'value', {
    get(this: object) {
      return values.get(this) ?? ''
    },
    set(this: object, next: unknown) {
      values.set(this, String(next))
    },
    configurable: true,
  })
  // React decides at module load whether the platform supports the `input`
  // event by probing `'oninput' in document` and then `document.createElement`
  // for a function behind the attribute. Without this the shim takes React's
  // legacy polyfill path, where a synthetic `change` never reaches `onChange`.
  Object.defineProperty(proto, 'oninput', {
    get(this: ShimNode) {
      return this.getAttribute?.('oninput') !== null && this.getAttribute?.('oninput') !== undefined
        ? () => {}
        : undefined
    },
    configurable: true,
  })
  Object.defineProperty(proto, 'options', {
    get(this: ShimNode) {
      const found: ShimNode[] = []
      const visit = (node: ShimNode) => {
        for (const child of node.childNodes ?? []) {
          if (child.nodeName === 'OPTION') found.push(child)
          visit(child)
        }
      }
      visit(this)
      return found
    },
    configurable: true,
  })
  return { dispatch: fire }
}

/** Local translator over the real `zh` dictionary, matching the injected seat. */
const dictionary: Record<string, string> = zh
function translate(key: string, params?: Record<string, unknown>): string {
  const template = dictionary[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}
const t = translate as AutoReviewSectionProps['t']

const BASE: AutoReviewPreferences = {
  enabled: false,
  reviewer: { mode: 'current' },
  timeoutMs: 8000,
  maxOutputTokens: 1024,
}

function routeOption(over: Partial<AutoReviewRouteOption> = {}): AutoReviewRouteOption {
  return {
    provider: 'deepseek',
    providerName: 'DeepSeek',
    model: 'deepseek-v4',
    modelName: 'DeepSeek V4',
    efforts: ['low', 'high'],
    defaultEffort: 'low',
    ...over,
  }
}

function status(over: Partial<AutoReviewStatus> = {}): AutoReviewStatus {
  return {
    preferences: { ...BASE },
    revision: 'r1',
    state: 'disabled',
    routes: [],
    activeReviews: 0,
    autoSessions: 0,
    failure: null,
    ...over,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

interface FakeApi {
  api: AutoReviewClientApi
  calls: { read: number; save: AutoReviewSaveRequest[] }
}

function fakeApi(
  read: () => Promise<AutoReviewStatus>,
  save?: (request: AutoReviewSaveRequest) => Promise<AutoReviewSaveResult>,
): FakeApi {
  const calls = { read: 0, save: [] as AutoReviewSaveRequest[] }
  return {
    calls,
    api: {
      async read() {
        calls.read += 1
        return read()
      },
      async save(request) {
        calls.save.push(request)
        if (!save) throw new Error('save not configured')
        return save(request)
      },
    },
  }
}

let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
  if (root) {
    await React.act(async () => root!.unmount())
    root = undefined
  }
})

async function settle(): Promise<void> {
  await React.act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function element(api: AutoReviewClientApi, connection?: AutoReviewConnectionSource) {
  return React.createElement(AutoReviewSection, {
    api,
    t,
    ...(connection === undefined ? {} : { connection }),
  })
}

async function render(
  api: AutoReviewClientApi,
  connection?: AutoReviewConnectionSource,
): Promise<ShimNode> {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  root = createRoot(container as unknown as HTMLElement)
  await React.act(async () => {
    root!.render(element(api, connection))
  })
  await settle()
  return container as unknown as ShimNode
}

/** Re-render the mounted section with replaced props (api or connection source). */
async function rerender(
  api: AutoReviewClientApi,
  connection?: AutoReviewConnectionSource,
): Promise<void> {
  await React.act(async () => {
    root!.render(element(api, connection))
  })
  await settle()
}

/** Move the connection source inside act, as a real transport event would. */
async function setConnection(
  conn: { set(next: number | undefined): void },
  next: number | undefined,
): Promise<void> {
  await React.act(async () => {
    conn.set(next)
  })
  await settle()
}

/** A controllable stand-in for the official connection-generation observable. */
function connectionSource(initial: number | undefined) {
  let value = initial
  const listeners = new Set<() => void>()
  const source: AutoReviewConnectionSource = {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    source,
    set(next: number | undefined) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

async function click(node: ShimNode): Promise<void> {
  await React.act(async () => {
    node.click?.()
  })
  await settle()
}

function walk(node: ShimNode, into: ShimNode[] = []): ShimNode[] {
  into.push(node)
  for (const child of node.childNodes ?? []) walk(child, into)
  return into
}

function byAttr(scope: ShimNode, attribute: string): ShimNode[] {
  return walk(scope).filter(
    (node) =>
      node.getAttribute?.(attribute) !== null && node.getAttribute?.(attribute) !== undefined,
  )
}

function one(scope: ShimNode, attribute: string, value?: string): ShimNode {
  const found = byAttr(scope, attribute).filter(
    (node) => value === undefined || node.getAttribute?.(attribute) === value,
  )
  expect(found.length, `expected exactly one [${attribute}] node`).toBe(1)
  return found[0]!
}

function maybe(scope: ShimNode, attribute: string): ShimNode | undefined {
  return byAttr(scope, attribute)[0]
}

function textOf(scope: ShimNode): string {
  return scope.textContent ?? ''
}

function isDisabled(node: ShimNode | undefined): boolean {
  return node !== undefined && (node.disabled === true || node.getAttribute?.('disabled') !== null)
}

function switchOf(scope: ShimNode): ShimNode {
  const found = walk(scope).find((node) => node.getAttribute?.('role') === 'switch')
  expect(found, 'the enable switch must exist').toBeDefined()
  return found!
}

async function typeBudget(container: ShimNode, field: string, value: string): Promise<void> {
  const input = one(container, 'data-opl-auto-review-budget', field)
  await React.act(async () => {
    // React's value tracker wraps the node's own `value` with a setter that also
    // updates the tracker, so assigning `input.value` looks unchanged to React.
    // Writing through the prototype setter is what a real keystroke does to the
    // tracker: the value moves behind React's back, and the `input` event sees it.
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input) as object,
      'value',
    )?.set
    setter?.call(input, value)
    input.dispatchEvent?.('input')
  })
  await settle()
}

function saveButton(scope: ShimNode): ShimNode {
  return one(scope, 'data-opl-auto-review-save')
}

function radios(scope: ShimNode): ShimNode[] {
  return walk(scope).filter(
    (node) => node.nodeName === 'INPUT' && node.getAttribute?.('type') === 'radio',
  )
}

function selectedValue(select: ShimNode): string | undefined {
  const chosen = walk(select).find((node) => node.nodeName === 'OPTION' && node.selected === true)
  return chosen === undefined ? undefined : (chosen.getAttribute?.('value') ?? chosen.value ?? '')
}

function optionValues(select: ShimNode): string[] {
  return walk(select)
    .filter((node) => node.nodeName === 'OPTION')
    .map((node) => node.getAttribute?.('value') ?? node.value ?? '')
}

describe('auto-review preferences (pure)', () => {
  it('preselects only an advertised effort and never invents one', () => {
    expect(advertisedEffort(routeOption())).toBe('low')
    expect(advertisedEffort(routeOption({ defaultEffort: 'extreme' }))).toBe('low')
    expect(advertisedEffort(routeOption({ defaultEffort: null }))).toBe('low')
    expect(advertisedEffort(routeOption({ efforts: [], defaultEffort: null }))).toBeUndefined()
  })

  it('builds a fixed route from exactly the advertised provider/model/effort', () => {
    const route = withFixedRoute(BASE, routeOption()).reviewer
    expect(route).toEqual({
      mode: 'fixed',
      route: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' },
    })
    const noEffort = withFixedRoute(
      BASE,
      routeOption({ efforts: [], defaultEffort: null }),
    ).reviewer
    expect(noEffort).toEqual({
      mode: 'fixed',
      route: { provider: 'deepseek', model: 'deepseek-v4' },
    })
  })

  it('ignores an effort the route does not advertise', () => {
    const fixed = withFixedRoute(BASE, routeOption())
    expect(
      effectivePreferences({
        ...emptyView(),
        draft: withFixedEffort(fixed, [routeOption()], 'medium'),
      }),
    ).toEqual(fixed)
    expect(
      effectivePreferences({
        ...emptyView(),
        draft: withFixedEffort(fixed, [routeOption()], 'high'),
      }),
    ).toEqual({
      ...fixed,
      reviewer: {
        mode: 'fixed',
        route: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' },
      },
    })
  })

  it('rejects only budgets that cannot be serialized, leaving the range to the Host', () => {
    expect(budgetIsSubmittable(BASE)).toBe(true)
    expect(budgetIsSubmittable({ ...BASE, timeoutMs: 0 })).toBe(false)
    expect(budgetIsSubmittable({ ...BASE, maxOutputTokens: Number.NaN })).toBe(false)
    // Out-of-range values are deliberately submittable: the Host revalidates.
    expect(budgetIsSubmittable({ ...BASE, timeoutMs: 999_999 })).toBe(true)
  })

  it('uses the shared DTO budget range instead of restating it', () => {
    expect(REVIEW_BUDGET_RANGE).toBe(AUTO_REVIEW_BUDGET_RANGE)
    expect(REVIEW_BUDGET_RANGE.timeoutMs).toEqual({ min: 1000, max: 60000 })
    expect(REVIEW_BUDGET_RANGE.maxOutputTokens).toEqual({ min: 64, max: 32768 })
  })

  it('keys a route by its exact provider/model pair', () => {
    expect(routeKey('a', 'b')).not.toBe(routeKey('ab', ''))
  })
})

function emptyView() {
  return {
    readState: 'ready' as const,
    reading: false,
    saving: false,
    dirty: false,
    stale: false,
    conflict: false,
    saved: false,
    uncertain: false,
    connected: true,
  }
}

describe('AutoReviewSettingsStore', () => {
  it('publishes a successful read and reports readiness', async () => {
    const { api } = fakeApi(async () => status())
    const store = new AutoReviewSettingsStore({ api })
    await store.load()
    expect(store.getSnapshot().readState).toBe('ready')
    expect(serviceReady(store.getSnapshot())).toBe(true)
    expect(store.getSnapshot().status?.revision).toBe('r1')
    store.detach()
  })

  it('saves as a compare-and-swap against the revision read last', async () => {
    const { api, calls } = fakeApi(
      async () => status(),
      async (request) => ({
        ok: true,
        status: status({ revision: 'r2', preferences: request.preferences }),
      }),
    )
    const store = new AutoReviewSettingsStore({ api })
    await store.load()
    store.edit({ ...BASE, enabled: true, timeoutMs: 9000 })
    await store.save()
    expect(calls.save).toHaveLength(1)
    expect(calls.save[0]!.expectedRevision).toBe('r1')
    expect(calls.save[0]!.preferences.timeoutMs).toBe(9000)
    expect(store.getSnapshot().saved).toBe(true)
    expect(store.getSnapshot().dirty).toBe(false)
    expect(store.getSnapshot().status?.revision).toBe('r2')
    store.detach()
  })

  it('keeps the rejected disable off the screen and honours the Host truth', async () => {
    const enabled = status({ state: 'ready', preferences: { ...BASE, enabled: true } })
    const { api } = fakeApi(
      async () => enabled,
      async () => ({
        ok: false,
        failure: 'auto-sessions-remain',
        status: { ...enabled, autoSessions: 2, revision: 'r1' },
      }),
    )
    const store = new AutoReviewSettingsStore({ api })
    await store.load()
    store.edit({ ...enabled.preferences, enabled: false })
    await store.save()
    const view = store.getSnapshot()
    expect(view.failure).toBe('auto-sessions-remain')
    // The Host still reports enabled, so that is what the form shows.
    expect(effectivePreferences(view)?.enabled).toBe(true)
    expect(view.dirty).toBe(false)
    store.detach()
  })

  it('requires a fresh read after a stale rejection', async () => {
    const { api, calls } = fakeApi(
      async () => status(),
      async () => ({ ok: false, failure: 'stale-settings', status: status({ revision: 'r2' }) }),
    )
    const store = new AutoReviewSettingsStore({ api })
    await store.load()
    store.edit({ ...BASE, timeoutMs: 9000 })
    await store.save()
    expect(store.getSnapshot().stale).toBe(true)
    expect(saveBlockedReasonKey(store.getSnapshot())).toBe('disabledReasonStale')
    await store.save()
    expect(calls.save).toHaveLength(1)
    await store.load()
    expect(store.getSnapshot().stale).toBe(false)
    expect(store.getSnapshot().dirty).toBe(true)
    store.detach()
  })

  it('never silently overwrites a dirty draft when a read sees a new revision', async () => {
    let current = status()
    const { api } = fakeApi(async () => current)
    const store = new AutoReviewSettingsStore({ api })
    await store.load()
    store.edit({ ...BASE, timeoutMs: 9000 })
    current = status({ revision: 'r2' })
    await store.load()
    const view = store.getSnapshot()
    expect(view.conflict).toBe(true)
    expect(view.dirty).toBe(true)
    expect(effectivePreferences(view)?.timeoutMs).toBe(9000)
    store.detach()
  })

  it('drops an answer from a superseded Host generation', async () => {
    const first = deferred<AutoReviewStatus>()
    const { api } = fakeApi(() => first.promise)
    const store = new AutoReviewSettingsStore({ api })
    const seen: string[] = []
    store.subscribe(() => seen.push(store.getSnapshot().readState))
    const pending = store.load()
    store.reset()
    first.resolve(status({ revision: 'old' }))
    await pending
    expect(store.getSnapshot().status).toBeUndefined()
    expect(store.getSnapshot().readState).toBe('loading')
    expect(seen).not.toContain('ready')
    store.detach()
  })

  it('becomes permanently silent after detach', async () => {
    const first = deferred<AutoReviewStatus>()
    const { api } = fakeApi(() => first.promise)
    const store = new AutoReviewSettingsStore({ api })
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    const pending = store.load()
    store.detach()
    const frozen = notifications
    first.resolve(status())
    await pending
    expect(notifications).toBe(frozen)
    expect(store.getSnapshot().status).toBeUndefined()
  })

  it('ignores a re-entrant save while one is in flight', async () => {
    const gate = deferred<AutoReviewSaveResult>()
    const { api, calls } = fakeApi(
      async () => status(),
      () => gate.promise,
    )
    const store = new AutoReviewSettingsStore({ api })
    await store.load()
    store.edit({ ...BASE, enabled: true })
    const first = store.save()
    const second = store.save()
    gate.resolve({ ok: true, status: status({ preferences: { ...BASE, enabled: true } }) })
    await Promise.all([first, second])
    expect(calls.save).toHaveLength(1)
    store.detach()
  })

  it('reports a read failure without inventing a status', async () => {
    const { api } = fakeApi(async () => {
      throw new Error('transport detail that must not be shown')
    })
    const store = new AutoReviewSettingsStore({ api })
    await store.load()
    expect(store.getSnapshot().readState).toBe('error')
    expect(store.getSnapshot().status).toBeUndefined()
    store.detach()
  })
})

describe('AutoReviewSection', () => {
  it('offers no actionable entry before the first read resolves', async () => {
    const gate = deferred<AutoReviewStatus>()
    const { api, calls } = fakeApi(() => gate.promise)
    const container = await render(api)
    expect(calls.read).toBe(1)
    expect(textOf(container)).toContain(zh.statusLoading)
    expect(radios(container)).toHaveLength(0)
    expect(maybe(container, 'data-opl-auto-review-save')).toBeUndefined()
    expect(() => switchOf(container)).toThrow()
    gate.resolve(status())
    await settle()
  })

  it('shows the default-off state and writes nothing when the switch is toggled', async () => {
    const { api, calls } = fakeApi(async () => status())
    const container = await render(api)
    const enable = switchOf(container)
    expect(enable.getAttribute?.('aria-checked')).toBe('false')
    expect(isDisabled(saveButton(container))).toBe(true)
    await click(enable)
    expect(calls.save).toHaveLength(0)
    expect(switchOf(container).getAttribute?.('aria-checked')).toBe('true')
    expect(textOf(container)).toContain(zh.draftDirty)
    // The explicit Save is now the only way this reaches the Host.
    expect(isDisabled(saveButton(container))).toBe(false)
  })

  it('saves the toggled state through exactly one read/save seam call', async () => {
    const { api, calls } = fakeApi(
      async () => status(),
      async (request) => ({
        ok: true,
        status: status({ revision: 'r2', state: 'ready', preferences: request.preferences }),
      }),
    )
    const container = await render(api)
    await click(switchOf(container))
    await click(saveButton(container))
    expect(calls.read).toBe(1)
    expect(calls.save).toHaveLength(1)
    expect(calls.save[0]!.expectedRevision).toBe('r1')
    expect(calls.save[0]!.preferences.enabled).toBe(true)
    expect(textOf(container)).toContain(zh.saved)
  })

  it('keeps showing the Host truth after a refused disable', async () => {
    const enabled = status({ state: 'ready', preferences: { ...BASE, enabled: true } })
    const { api } = fakeApi(
      async () => enabled,
      async () => ({
        ok: false,
        failure: 'auto-sessions-remain',
        status: { ...enabled, autoSessions: 3 },
      }),
    )
    const container = await render(api)
    await click(switchOf(container))
    expect(switchOf(container).getAttribute?.('aria-checked')).toBe('false')
    await click(saveButton(container))
    expect(switchOf(container).getAttribute?.('aria-checked')).toBe('true')
    expect(
      maybe(container, 'data-opl-auto-review-failure')?.getAttribute?.(
        'data-opl-auto-review-failure',
      ),
    ).toBe('auto-sessions-remain')
    expect(textOf(container)).toContain(zh['failure.auto-sessions-remain'])
  })

  it('disables duplicate submits while a save is in flight and reports the busy reason', async () => {
    const gate = deferred<AutoReviewSaveResult>()
    const { api, calls } = fakeApi(
      async () => status(),
      () => gate.promise,
    )
    const container = await render(api)
    await click(switchOf(container))
    const save = saveButton(container)
    await React.act(async () => {
      save.click?.()
      save.click?.()
    })
    await settle()
    expect(calls.save).toHaveLength(1)
    expect(isDisabled(saveButton(container))).toBe(true)
    expect(textOf(container)).toContain(zh.saving)
    gate.resolve({ ok: true, status: status({ preferences: { ...BASE, enabled: true } }) })
    await settle()
  })

  it('reports a stale save and forces a re-read before another attempt', async () => {
    let current = status()
    const { api, calls } = fakeApi(
      async () => current,
      async () => {
        current = status({ revision: 'r2' })
        return { ok: false, failure: 'stale-settings', status: current }
      },
    )
    const container = await render(api)
    await click(switchOf(container))
    await click(saveButton(container))
    expect(textOf(container)).toContain(zh.stale)
    expect(isDisabled(saveButton(container))).toBe(true)
    await click(saveButton(container))
    expect(calls.save).toHaveLength(1)
    await click(one(container, 'data-opl-auto-review-refresh'))
    expect(maybe(container, 'data-opl-auto-review-stale')).toBeUndefined()
    expect(calls.read).toBe(2)
  })

  it('keeps the still-valid draft and shows a fixed label after a failed save', async () => {
    const { api, calls } = fakeApi(
      async () => status(),
      async () => ({ ok: false, failure: 'save-failed', status: status() }),
    )
    const container = await render(api)
    await typeBudget(container, 'timeoutMs', '9000')
    await click(saveButton(container))
    expect(calls.save).toHaveLength(1)
    expect(calls.save[0]!.preferences.timeoutMs).toBe(9000)
    expect(textOf(container)).toContain(zh['failure.save-failed'])
    expect(
      one(container, 'data-opl-auto-review-dirty').getAttribute?.('data-opl-auto-review-dirty'),
    ).toBe('true')
    expect(one(container, 'data-opl-auto-review-budget', 'timeoutMs').value).toBe('9000')
    // The failure text never quotes a transport message.
    expect(textOf(container)).not.toContain('transport detail')
  })

  it('disables every entry and offers a retry when the read fails', async () => {
    let fail = true
    const { api, calls } = fakeApi(async () => {
      if (fail) throw new Error('raw provider failure that must not be shown')
      return status()
    })
    const container = await render(api)
    expect(textOf(container)).toContain(zh.readFailed)
    expect(textOf(container)).not.toContain('raw provider failure')
    fail = false
    await click(one(container, 'data-opl-auto-review-retry'))
    expect(calls.read).toBe(2)
    expect(switchOf(container)).toBeDefined()
  })

  it('disables the entries after a failed re-read instead of showing a stale screen as current', async () => {
    let fail = false
    const { api } = fakeApi(async () => {
      if (fail) throw new Error('nope')
      return status({ state: 'ready' })
    })
    const container = await render(api)
    fail = true
    await click(one(container, 'data-opl-auto-review-refresh'))
    expect(isDisabled(switchOf(container))).toBe(true)
    expect(textOf(container)).toContain(zh.disabledReasonReadFailed)
  })

  it('keeps a dirty draft when a re-read reports a newer revision', async () => {
    let current = status()
    const { api } = fakeApi(async () => current)
    const container = await render(api)
    await typeBudget(container, 'timeoutMs', '9000')
    expect(
      one(container, 'data-opl-auto-review-dirty').getAttribute?.('data-opl-auto-review-dirty'),
    ).toBe('true')
    current = status({ revision: 'r2' })
    await click(one(container, 'data-opl-auto-review-refresh'))
    expect(maybe(container, 'data-opl-auto-review-conflict')).toBeDefined()
    expect(textOf(container)).toContain(zh.conflict)
    expect(
      one(container, 'data-opl-auto-review-dirty').getAttribute?.('data-opl-auto-review-dirty'),
    ).toBe('true')
    expect(one(container, 'data-opl-auto-review-budget', 'timeoutMs').value).toBe('9000')
  })

  it('renders exactly the advertised provider/model/effort options', async () => {
    const routes = [
      routeOption(),
      routeOption({
        model: 'deepseek-r2',
        modelName: 'DeepSeek R2',
        efforts: ['low'],
        defaultEffort: 'low',
      }),
      routeOption({
        provider: 'other',
        providerName: 'Other',
        model: 'x',
        modelName: 'X',
        efforts: ['medium'],
        defaultEffort: null,
      }),
    ]
    const fixed: AutoReviewPreferences = {
      ...BASE,
      reviewer: {
        mode: 'fixed',
        route: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' },
      },
    }
    const { api } = fakeApi(async () => status({ state: 'ready', routes, preferences: fixed }))
    const container = await render(api)
    const provider = one(container, 'data-opl-auto-review-select', 'provider')
    const model = one(container, 'data-opl-auto-review-select', 'model')
    const effort = one(container, 'data-opl-auto-review-select', 'effort')
    expect(optionValues(provider)).toEqual(['deepseek', 'other'])
    expect(optionValues(model)).toEqual(['deepseek-v4', 'deepseek-r2'])
    expect(optionValues(effort)).toEqual(['low', 'high'])
    expect(selectedValue(effort)).toBe('low')
    expect(textOf(container)).toContain('DeepSeek V4')
  })

  it('shows decision models in their own single selector and keeps them out of reviewer choices', async () => {
    const decision = routeOption({
      provider: 'bamboo-startlux',
      providerName: 'BambooNode · StartLux',
      model: 'startlux-decision-27b-autothink',
      modelName: 'StartLux Decision 27B AutoThink',
      efforts: [],
      defaultEffort: null,
      kind: 'decision',
    })
    const preferences: AutoReviewPreferences = {
      ...BASE,
      reviewer: { mode: 'decision', route: { provider: decision.provider, model: decision.model } },
    }
    const { api } = fakeApi(async () => status({ routes: [routeOption(), decision], preferences }))
    const container = await render(api)
    const selector = one(container, 'data-opl-auto-review-select', 'decision-model')
    expect(optionValues(selector)).toEqual([`${decision.provider}\u0000${decision.model}`])
    expect(selectedValue(selector)).toBe(`${decision.provider}\u0000${decision.model}`)
    expect(
      byAttr(container, 'data-opl-auto-review-select').some(
        (node) =>
          node.getAttribute?.('data-opl-auto-review-select') === 'provider' ||
          node.getAttribute?.('data-opl-auto-review-select') === 'model',
      ),
    ).toBe(false)
    expect(radios(container).find((radio) => radio.value === 'fixed')?.checked).toBe(false)
    expect(radios(container).find((radio) => radio.value === 'decision')?.checked).toBe(true)
    const decisionOnly = await render(
      fakeApi(async () => status({ routes: [decision], preferences })).api,
    )
    expect(isDisabled(radios(decisionOnly).find((radio) => radio.value === 'fixed'))).toBe(true)
    expect(isDisabled(radios(decisionOnly).find((radio) => radio.value === 'decision'))).toBe(false)
  })

  it('submits the exact advertised effort the user chooses', async () => {
    const routes = [routeOption()]
    const fixed: AutoReviewPreferences = {
      ...BASE,
      reviewer: {
        mode: 'fixed',
        route: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' },
      },
    }
    const { api, calls } = fakeApi(
      async () => status({ state: 'ready', routes, preferences: fixed }),
      async (request) => ({
        ok: true,
        status: status({
          state: 'ready',
          routes,
          revision: 'r2',
          preferences: request.preferences,
        }),
      }),
    )
    const container = await render(api)
    const effort = one(container, 'data-opl-auto-review-select', 'effort')
    await React.act(async () => {
      effort.value = 'high'
      effort.dispatchEvent?.('change')
    })
    await settle()
    expect(
      one(container, 'data-opl-auto-review-dirty').getAttribute?.('data-opl-auto-review-dirty'),
    ).toBe('true')
    await click(saveButton(container))
    expect(calls.save).toHaveLength(1)
    expect(calls.save[0]!.preferences.reviewer).toEqual({
      mode: 'fixed',
      route: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' },
    })
  })

  it('reports no route and blocks the independent choice when the Host advertises none', async () => {
    const { api } = fakeApi(async () => status({ state: 'ready', routes: [] }))
    const container = await render(api)
    expect(textOf(container)).toContain(zh.routesEmpty)
    const fixedRadio = radios(container).find((node) => node.value === 'fixed')
    expect(isDisabled(fixedRadio)).toBe(true)
    const decisionRadio = radios(container).find((node) => node.value === 'decision')
    expect(isDisabled(decisionRadio)).toBe(true)
  })

  it('lets a successfully read but unavailable reviewer be repaired or disabled', async () => {
    const { api, calls } = fakeApi(
      async () =>
        status({
          state: 'unavailable',
          preferences: { ...BASE, enabled: true },
          routes: [routeOption()],
        }),
      async (request) => ({
        ok: true,
        status: status({ revision: 'r2', preferences: request.preferences }),
      }),
    )
    const container = await render(api)
    // The read succeeded, so the settings are editable even though the reviewer
    // itself is unavailable; the Host still validates and may refuse the write.
    expect(textOf(container)).toContain(zh.routeUnavailable)
    expect(isDisabled(switchOf(container))).toBe(false)
    expect(isDisabled(radios(container)[1])).toBe(false)
    expect(isDisabled(one(container, 'data-opl-auto-review-refresh'))).toBe(false)
    await click(switchOf(container))
    await click(saveButton(container))
    expect(calls.save).toHaveLength(1)
    expect(calls.save[0]!.preferences.enabled).toBe(false)
  })

  it('states the saveable budget range and the Host revalidation', async () => {
    const { api } = fakeApi(async () => status())
    const container = await render(api)
    const copy = translate('limitsRange', {
      timeoutMin: REVIEW_BUDGET_RANGE.timeoutMs.min,
      timeoutMax: REVIEW_BUDGET_RANGE.timeoutMs.max,
      outputMin: REVIEW_BUDGET_RANGE.maxOutputTokens.min,
      outputMax: REVIEW_BUDGET_RANGE.maxOutputTokens.max,
    })
    expect(textOf(container)).toContain(copy)
    expect(textOf(container)).toContain('Host')
  })

  it('never fills the panel back in after unmount', async () => {
    const gate = deferred<AutoReviewStatus>()
    const { api, calls } = fakeApi(() => gate.promise)
    const container = await render(api)
    await React.act(async () => root!.unmount())
    root = undefined
    const afterUnmount = textOf(container)
    gate.resolve(status({ revision: 'late' }))
    await settle()
    // The detached store published nothing, so nothing was written back.
    expect(textOf(container)).toBe(afterUnmount)
    expect(textOf(container)).not.toContain('late')
    expect(calls.save).toHaveLength(0)
  })
})

describe('auto-review plugin wiring contract', () => {
  it('owns copy only; the execution page owns its single visible entry', () => {
    expect(inject).toEqual(['locale'])
    expect(inject).not.toContain('sessions')
    expect(inject).not.toContain('sessionPermissions')
    const dictionaries: unknown[] = []
    const ctx = {
      effect: (fn: () => unknown) => {
        fn()
        return () => {}
      },
      locale: {
        register: (ns: string, dicts: unknown) => {
          dictionaries.push({ ns, dicts })
          return () => {}
        },
        bind: () => (key: string) => dictionary[key] ?? key,
      },
    }
    apply(ctx as never)
    expect(dictionaries).toEqual([{ ns: AUTO_REVIEW_NAMESPACE, dicts: { zh, en } }])
  })
})

describe('auto-review locale', () => {
  it('keeps both dictionaries complete', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
  })
})

describe('auto-review read/write exclusion and unconfirmed writes', () => {
  it('refuses a save while a read is in flight, and a read while a save is in flight', async () => {
    const readGate = deferred<AutoReviewStatus>()
    const saveGate = deferred<AutoReviewSaveResult>()
    let reads = 0
    const { api, calls } = fakeApi(
      () => (++reads === 1 ? Promise.resolve(status()) : readGate.promise),
      () => saveGate.promise,
    )
    const store = new AutoReviewSettingsStore({ api })
    await store.load()
    store.edit({ ...BASE, enabled: true })
    const reading = store.load()
    await store.save()
    expect(calls.save).toHaveLength(0)
    readGate.resolve(status())
    await reading
    const saving = store.save()
    await store.load()
    expect(calls.read).toBe(2)
    saveGate.resolve({ ok: true, status: status({ preferences: { ...BASE, enabled: true } }) })
    await saving
    store.detach()
  })

  it('marks a transport-failed save unconfirmed and clears it only on a fresh read', async () => {
    let fail = true
    const { api, calls } = fakeApi(
      async () => status(),
      async () => {
        if (fail) throw new Error('carrier reset')
        return { ok: true, status: status({ revision: 'r2' }) }
      },
    )
    const store = new AutoReviewSettingsStore({ api })
    await store.load()
    store.edit({ ...BASE, enabled: true })
    await store.save()
    expect(store.getSnapshot().uncertain).toBe(true)
    expect(store.getSnapshot().draft).toBeDefined()
    await store.save()
    expect(calls.save).toHaveLength(1)
    fail = false
    await store.load()
    expect(store.getSnapshot().uncertain).toBe(false)
    store.detach()
  })
})

describe('auto-review Host generation lifecycle (store)', () => {
  it('drops a superseded api answer and re-reads under the replacement', async () => {
    const oldRead = deferred<AutoReviewStatus>()
    const old = fakeApi(() => oldRead.promise)
    const replacement = fakeApi(async () => status({ revision: 'new' }))
    const store = new AutoReviewSettingsStore({ api: old.api })
    const pending = store.load()
    store.mount(replacement.api, false, undefined)
    await store.load()
    oldRead.resolve(status({ revision: 'old' }))
    await pending
    expect(replacement.calls.read).toBe(1)
    expect(store.getSnapshot().status?.revision).toBe('new')
    store.detach()
  })

  it('keeps the last read on loss but refuses edits and writes until a generation returns', async () => {
    const { api, calls } = fakeApi(async () => status())
    const store = new AutoReviewSettingsStore({ api })
    store.mount(api, true, 1)
    await store.load()
    expect(store.getSnapshot().connected).toBe(true)
    store.mount(api, true, undefined)
    const lost = store.getSnapshot()
    expect(lost.connected).toBe(false)
    expect(lost.status?.revision).toBe('r1')
    store.edit({ ...BASE, enabled: true })
    expect(store.getSnapshot().draft).toBeUndefined()
    await store.save()
    expect(calls.save).toHaveLength(0)
    store.mount(api, true, 2)
    expect(store.getSnapshot().connected).toBe(true)
    expect(store.getSnapshot().status).toBeUndefined()
    store.detach()
  })
})

describe('auto-review component generation negatives', () => {
  it('disables Save and the switch while a refresh is unresolved and refuses the write', async () => {
    const pending = deferred<AutoReviewStatus>()
    let reads = 0
    const { api, calls } = fakeApi(() =>
      ++reads === 1 ? Promise.resolve(status()) : pending.promise,
    )
    const container = await render(api)
    await typeBudget(container, 'timeoutMs', '9000')
    expect(isDisabled(saveButton(container))).toBe(false)
    await click(one(container, 'data-opl-auto-review-refresh'))
    expect(isDisabled(saveButton(container))).toBe(true)
    expect(isDisabled(switchOf(container))).toBe(true)
    expect(textOf(container)).toContain(zh.disabledReasonRefreshing)
    await click(saveButton(container))
    expect(calls.save).toHaveLength(0)
    pending.resolve(status())
    await settle()
  })

  it('re-reads a replaced api and ignores the late answer of the old Host', async () => {
    const oldRead = deferred<AutoReviewStatus>()
    const old = fakeApi(() => oldRead.promise)
    const replacement = fakeApi(async () => status({ revision: 'new-host' }))
    const container = await render(old.api)
    await rerender(replacement.api)
    oldRead.resolve(
      status({ revision: 'old-host', state: 'ready', preferences: { ...BASE, enabled: true } }),
    )
    await settle()
    expect(replacement.calls.read).toBe(1)
    expect(
      one(container, 'data-opl-auto-review-revision').getAttribute?.(
        'data-opl-auto-review-revision',
      ),
    ).toBe('new-host')
    expect(
      one(container, 'data-opl-auto-review-effective-enabled').getAttribute?.(
        'data-opl-auto-review-effective-enabled',
      ),
    ).toBe('false')
  })

  it('treats a transport-failed save as unconfirmed and never resends it', async () => {
    let fail = true
    const { api, calls } = fakeApi(
      async () => status(),
      async () => {
        if (fail) throw new Error('carrier reset')
        return { ok: true, status: status({ revision: 'r2' }) }
      },
    )
    const container = await render(api)
    await typeBudget(container, 'timeoutMs', '9000')
    await click(saveButton(container))
    expect(calls.save).toHaveLength(1)
    expect(maybe(container, 'data-opl-auto-review-uncertain')).toBeDefined()
    expect(textOf(container)).toContain(zh.uncertainNotice)
    await click(saveButton(container))
    expect(calls.save).toHaveLength(1)
    expect(isDisabled(saveButton(container))).toBe(true)
    fail = false
    await click(one(container, 'data-opl-auto-review-refresh'))
    expect(maybe(container, 'data-opl-auto-review-uncertain')).toBeUndefined()
  })

  it('disables editing and drops in-flight work while the generation is missing, then re-reads a new one', async () => {
    const conn = connectionSource(1)
    const gate = deferred<AutoReviewStatus>()
    let reads = 0
    const { api, calls } = fakeApi(() => {
      reads += 1
      if (reads === 1) return Promise.resolve(status({ revision: 'r1' }))
      if (reads === 2) return gate.promise
      return Promise.resolve(status({ revision: 'r2' }))
    })
    const container = await render(api, conn.source)
    expect(
      one(container, 'data-opl-auto-review-revision').getAttribute?.(
        'data-opl-auto-review-revision',
      ),
    ).toBe('r1')
    await typeBudget(container, 'timeoutMs', '9000')
    await click(one(container, 'data-opl-auto-review-refresh'))
    await setConnection(conn, undefined)
    expect(isDisabled(switchOf(container))).toBe(true)
    expect(textOf(container)).toContain(zh.connectionLost)
    // The unsaved draft is kept rather than silently discarded.
    expect(
      one(container, 'data-opl-auto-review-dirty').getAttribute?.('data-opl-auto-review-dirty'),
    ).toBe('true')
    await click(saveButton(container))
    expect(calls.save).toHaveLength(0)
    gate.resolve(status({ revision: 'late-old' }))
    await settle()
    expect(
      one(container, 'data-opl-auto-review-revision').getAttribute?.(
        'data-opl-auto-review-revision',
      ),
    ).toBe('r1')
    await setConnection(conn, 2)
    expect(
      one(container, 'data-opl-auto-review-revision').getAttribute?.(
        'data-opl-auto-review-revision',
      ),
    ).toBe('r2')
    expect(calls.save).toHaveLength(0)
  })

  it('never lets an old generation save result backfill a new generation', async () => {
    const conn = connectionSource(1)
    const saveGate = deferred<AutoReviewSaveResult>()
    const { api, calls } = fakeApi(
      async () => status({ revision: 'r1' }),
      () => saveGate.promise,
    )
    const container = await render(api, conn.source)
    await typeBudget(container, 'timeoutMs', '9000')
    await click(saveButton(container))
    expect(calls.save).toHaveLength(1)
    await setConnection(conn, 2)
    saveGate.resolve({
      ok: true,
      status: status({ revision: 'r1-old', preferences: { ...BASE, timeoutMs: 9000 } }),
    })
    await settle()
    expect(
      one(container, 'data-opl-auto-review-revision').getAttribute?.(
        'data-opl-auto-review-revision',
      ),
    ).toBe('r1')
    expect(maybe(container, 'data-opl-auto-review-saved')).toBeUndefined()
  })

  it('never lets an old generation save rejection backfill a new generation', async () => {
    const conn = connectionSource(1)
    const saveGate = deferred<AutoReviewSaveResult>()
    const { api, calls } = fakeApi(
      async () => status({ revision: 'r1' }),
      () => saveGate.promise,
    )
    const container = await render(api, conn.source)
    await typeBudget(container, 'timeoutMs', '9000')
    await click(saveButton(container))
    expect(calls.save).toHaveLength(1)
    await setConnection(conn, 2)
    saveGate.resolve({
      ok: false,
      failure: 'auto-sessions-remain',
      status: status({
        revision: 'r1-old',
        preferences: { ...BASE, enabled: true },
        autoSessions: 2,
      }),
    })
    await settle()
    expect(maybe(container, 'data-opl-auto-review-failure')).toBeUndefined()
    expect(
      one(container, 'data-opl-auto-review-revision').getAttribute?.(
        'data-opl-auto-review-revision',
      ),
    ).toBe('r1')
  })

  it('survives a StrictMode mount/unmount/mount cycle', async () => {
    const { api, calls } = fakeApi(
      async () => status(),
      async (request) => ({
        ok: true,
        status: status({ revision: 'r2', preferences: request.preferences }),
      }),
    )
    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    root = createRoot(container as unknown as HTMLElement)
    await React.act(async () => {
      root!.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(AutoReviewSection, { api, t }),
        ),
      )
    })
    await settle()
    const scope = container as unknown as ShimNode
    expect(calls.read).toBeGreaterThanOrEqual(1)
    expect(calls.read).toBeLessThanOrEqual(2)
    expect(switchOf(scope)).toBeDefined()
    await click(switchOf(scope))
    expect(isDisabled(saveButton(scope))).toBe(false)
    await click(saveButton(scope))
    expect(calls.save).toHaveLength(1)
  })

  it('keeps the effective Host state apart from an unsaved draft', async () => {
    const { api } = fakeApi(async () =>
      status({ state: 'ready', preferences: { ...BASE, enabled: false } }),
    )
    const container = await render(api)
    expect(
      one(container, 'data-opl-auto-review-effective-enabled').getAttribute?.(
        'data-opl-auto-review-effective-enabled',
      ),
    ).toBe('false')
    await click(switchOf(container))
    expect(switchOf(container).getAttribute?.('aria-checked')).toBe('true')
    // The draft toggle does not become the effective state on screen.
    expect(
      one(container, 'data-opl-auto-review-effective-enabled').getAttribute?.(
        'data-opl-auto-review-effective-enabled',
      ),
    ).toBe('false')
    expect(maybe(container, 'data-opl-auto-review-draft-pending')).toBeDefined()
    expect(textOf(container)).toContain(zh.effectiveOff)
  })
})
