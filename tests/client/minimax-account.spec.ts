/**
 * MiniMax official account card — real component events over a scripted RPC.
 *
 * The card is mounted with the same minimal DOM as the sibling Client specs and
 * driven only through what a user does: choosing cn/global, pressing login,
 * sign-out, cancel and refresh. Every answer is a local promise, so the tests can
 * settle them in any order and prove that a late or cross-region answer never
 * replaces the current region's view.
 *
 * Product decisions pinned here:
 *  - cn is the explicit default; only cn and global exist, with no "current".
 *  - opening the card and changing region read that region's real status.
 *  - signed-in offers sign-out, signed-out offers login, unknown offers refresh
 *    and re-login but never claims the user is signed out.
 *  - a started login is cancellable immediately through its own cancel RPC, and
 *    cancel never signs the account out.
 *  - a failed action is reported as unconfirmed and followed by a real re-read,
 *    never as proof that the service did nothing.
 *  - pending authorization polls only while it is real, and the timer is cleared.
 */
import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'
import type { MiniMaxAccountStatus } from '../../src/execution/contracts/minimax-account.ts'
import { minimaxAccountZh } from '../../src/execution/client/minimax-account-locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', { type: 'button', ...props }, children),
}))

// `./dom.ts` installs the process DOM on import, before React DOM is loaded.
const dom = createTestDom()
const { createRoot } = await import('react-dom/client')
const { MiniMaxAccountSection } = await import(
  '../../src/execution/client/MiniMaxAccountSection.tsx'
)

type Region = 'cn' | 'global'
type Node = {
  nodeName: string
  textContent: string | null
  childNodes: Node[]
  parentNode: Node | null
  value: string
  click: () => boolean
  dispatchEvent: (type: string) => boolean
  getAttribute: (name: string) => string | null
}

/**
 * Give the shared DOM shim the pieces this card needs and the shim does not model:
 * bubbling listeners, element `value`, and `select.options` (React walks it when
 * applying a controlled value). Nothing under test is reimplemented.
 */
function completeDom() {
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
  const dispatch = function (type: string, target: object): boolean {
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
    let node = target as { parentNode: object | null } | null
    while (node) {
      for (const listener of [...(listeners.get(node)?.get(type) ?? [])]) listener(event)
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
  const values = new WeakMap<object, string>()
  Object.defineProperty(proto, 'value', {
    get(this: Node) {
      // React writes an <option>'s value as an attribute and selects it through
      // `option.selected`; a real <select>.value is derived from that selection.
      if (this.nodeName === 'OPTION')
        return values.get(this) ?? this.getAttribute('value') ?? this.textContent ?? ''
      if (this.nodeName === 'SELECT') {
        const selected = (this as Node & { options?: Node[] }).options?.find(
          (option) => (option as Node & { selected?: boolean }).selected,
        )
        return selected?.value ?? ''
      }
      return values.get(this) ?? ''
    },
    set(this: Node, next: unknown) {
      values.set(this, String(next))
      if (this.nodeName === 'SELECT') {
        const selectedValue = String(next)
        for (const option of (this as Node & { options?: Node[] }).options ?? [])
          (option as Node & { selected?: boolean }).selected = option.value === selectedValue
      }
    },
    configurable: true,
  })
  Object.defineProperty(proto, 'options', {
    get(this: Node) {
      const found: Node[] = []
      const visit = (node: Node) => {
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
}
completeDom()

function walk(node: unknown, into: Node[] = []): Node[] {
  const element = node as Node
  into.push(element)
  for (const child of element.childNodes ?? []) walk(child, into)
  return into
}
function control(scope: unknown, attribute: string): Node {
  const found = walk(scope).find((node) => node.getAttribute?.(attribute) !== null)
  expect(found, `找不到 ${attribute}`).toBeDefined()
  return found!
}
function has(scope: unknown, attribute: string): boolean {
  return walk(scope).some((node) => node.getAttribute?.(attribute) !== null)
}
function disabled(node: Node): boolean {
  return (
    node.getAttribute('disabled') !== null || (node as { disabled?: boolean }).disabled === true
  )
}
const text = (scope: unknown) => (scope as Node).textContent ?? ''

const roots: Root[] = []
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function status(overrides: Partial<MiniMaxAccountStatus> = {}): MiniMaxAccountStatus {
  return {
    installed: true,
    region: 'cn',
    loginState: 'signed-out',
    loginPending: false,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type Handler = (method: string, request: { region: Region }) => Promise<MiniMaxAccountStatus>
function fixture(handler: Handler) {
  const calls: { method: string; request: { region: Region } }[] = []
  const call = (async (method: string, request: { region: Region }) => {
    calls.push({ method, request })
    return handler(method, request)
  }) as unknown as ExecutionCall
  return { call, calls }
}

async function mount(call: ExecutionCall) {
  const container = dom.container()
  const root = createRoot(container as unknown as Element)
  roots.push(root)
  await act(async () => {
    root.render(
      React.createElement(MiniMaxAccountSection, {
        call,
        t: (key: keyof typeof minimaxAccountZh) => minimaxAccountZh[key],
      }),
    )
  })
  return { container, root }
}

async function press(scope: unknown, attribute: string) {
  const node = control(scope, attribute)
  await act(async () => {
    node.click()
  })
  return node
}

async function chooseRegion(scope: unknown, region: Region) {
  const select = control(scope, 'data-opl-region-select')
  await act(async () => {
    select.value = region
    select.dispatchEvent('change')
  })
}

describe('MiniMax official account card', () => {
  it('opens on cn, reads that region, and offers only cn/global', async () => {
    const { call, calls } = fixture(async (_method, request) => status({ region: request.region }))
    const view = await mount(call)

    expect(calls).toEqual([{ method: 'minimax-account-status', request: { region: 'cn' } }])
    expect(control(view.container, 'data-opl-region-select').value).toBe('cn')
    const options = walk(view.container)
      .filter((node) => node.nodeName === 'OPTION')
      .map((node) => node.textContent)
    expect(options).toEqual(['中国大陆', '国际版'])
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).not.toContain('沿用')
    expect(has(view.container, 'data-opl-login')).toBe(true)
    expect(has(view.container, 'data-opl-logout')).toBe(false)
    expect(has(view.container, 'data-opl-cancel')).toBe(false)
  })

  it('reads the newly selected region and ignores a late answer from the old one', async () => {
    const cn = deferred<MiniMaxAccountStatus>()
    const global = deferred<MiniMaxAccountStatus>()
    const { call, calls } = fixture((_method, request) =>
      request.region === 'cn' ? cn.promise : global.promise,
    )
    const view = await mount(call)
    expect(calls).toEqual([{ method: 'minimax-account-status', request: { region: 'cn' } }])

    await chooseRegion(view.container, 'global')
    expect(calls).toEqual([
      { method: 'minimax-account-status', request: { region: 'cn' } },
      { method: 'minimax-account-status', request: { region: 'global' } },
    ])

    await act(async () => {
      global.resolve(status({ region: 'global', loginState: 'signed-out' }))
    })
    expect(text(view.container)).toContain('未登录')

    // The cn read belongs to the previous view; it must not turn global signed in.
    await act(async () => {
      cn.resolve(status({ region: 'cn', loginState: 'signed-in' }))
    })
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).not.toContain('已登录')
  })

  it('shows signed-in and signs out only when the user presses sign-out', async () => {
    let signedIn = true
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-status')
        return status({
          region: request.region,
          loginState: signedIn ? 'signed-in' : 'signed-out',
        })
      if (method === 'minimax-account-logout') {
        signedIn = false
        return status({ region: request.region, loginState: 'signed-out' })
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)
    expect(text(view.container)).toContain('已登录')
    expect(has(view.container, 'data-opl-logout')).toBe(true)
    expect(has(view.container, 'data-opl-login')).toBe(false)
    expect(calls.map((call) => call.method)).toEqual(['minimax-account-status'])

    await press(view.container, 'data-opl-logout')
    expect(calls).toContainEqual({
      method: 'minimax-account-logout',
      request: { region: 'cn' },
    })
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).toContain('已退出官方账号')
    expect(has(view.container, 'data-opl-login')).toBe(true)
  })

  it('does not offer sign-out when the state is unknown, but still offers refresh and re-login', async () => {
    const { call } = fixture(async (_method, request) =>
      status({ region: request.region, loginState: 'unknown' }),
    )
    const view = await mount(call)
    expect(text(view.container)).toContain('登录状态未知')
    expect(has(view.container, 'data-opl-logout')).toBe(false)
    expect(has(view.container, 'data-opl-refresh')).toBe(true)
    const login = control(view.container, 'data-opl-login')
    expect(login.textContent).toContain('重新登录')
    expect(disabled(login)).toBe(false)
  })

  it('shows pending sign-out separately and allows a manual refresh to confirm completion', async () => {
    let loginState: MiniMaxAccountStatus['loginState'] = 'signing-out'
    const interval = vi.spyOn(globalThis, 'setInterval')
    const { call, calls } = fixture(async (_method, request) =>
      status({ region: request.region, loginState }),
    )
    const view = await mount(call)
    expect(text(view.container)).toContain('等待官方完成退出')
    expect(text(view.container)).not.toContain('已登录')
    expect(has(view.container, 'data-opl-login')).toBe(false)
    expect(disabled(control(view.container, 'data-opl-logout'))).toBe(true)
    expect(disabled(control(view.container, 'data-opl-refresh'))).toBe(false)
    expect(interval.mock.calls.some((call) => call[1] === 2000)).toBe(false)

    loginState = 'signed-out'
    await press(view.container, 'data-opl-refresh')
    expect(text(view.container)).toContain('未登录')
    expect(disabled(control(view.container, 'data-opl-login'))).toBe(false)
    expect(calls.map((call) => call.method)).toEqual([
      'minimax-account-status',
      'minimax-account-status',
    ])
  })

  it.each([
    ['signing-out', '官方退出仍在处理中'],
    ['signed-in', '重新读取后仍为已登录'],
    ['unknown', '无法确认退出结果'],
  ] as const)(
    'reports a %s logout result without claiming success',
    async (loginState, message) => {
      const { call } = fixture(async (method, request) =>
        status({
          region: request.region,
          loginState: method === 'minimax-account-logout' ? loginState : 'signed-in',
        }),
      )
      const view = await mount(call)
      await press(view.container, 'data-opl-logout')
      expect(text(view.container)).toContain(message)
      expect(text(view.container)).not.toContain('已退出官方账号')
      if (loginState === 'signing-out') {
        expect(text(view.container)).toContain('等待官方完成退出')
        expect(disabled(control(view.container, 'data-opl-logout'))).toBe(true)
        expect(has(view.container, 'data-opl-login')).toBe(false)
      }
    },
  )

  it('re-reads pending logout after an unconfirmed request without labelling it signed-in', async () => {
    let reads = 0
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-logout') throw Error('unconfirmed')
      return status({
        region: request.region,
        loginState: ++reads === 1 ? 'signed-in' : 'signing-out',
      })
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-logout')
    expect(calls.filter((call) => call.method === 'minimax-account-status')).toHaveLength(2)
    expect(text(view.container)).toContain('官方退出仍在处理中')
    expect(text(view.container)).not.toContain('重新读取后仍为已登录')
    expect(text(view.container)).not.toContain('已退出官方账号')
  })

  it('keeps the signed-in Global view when an earlier CN logout finishes pending', async () => {
    const logout = deferred<MiniMaxAccountStatus>()
    let cnState: MiniMaxAccountStatus['loginState'] = 'signed-in'
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-logout') return logout.promise
      return status({
        region: request.region,
        loginState: request.region === 'cn' ? cnState : 'signed-in',
      })
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-logout')
    await chooseRegion(view.container, 'global')
    cnState = 'signing-out'
    await act(async () => {
      logout.resolve(status({ region: 'cn', loginState: cnState }))
    })
    expect(text(view.container)).toContain('已登录')
    expect(text(view.container)).not.toContain('等待官方完成退出')
    expect(calls.filter((call) => call.method === 'minimax-account-logout')).toEqual([
      { method: 'minimax-account-logout', request: { region: 'cn' } },
    ])
    await chooseRegion(view.container, 'cn')
    expect(text(view.container)).toContain('等待官方完成退出')
    expect(text(view.container)).not.toContain('已登录')
  })

  it('refreshes the selected region through a user read', async () => {
    let reads = 0
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-status') {
        reads++
        return status({
          region: request.region,
          loginState: reads === 1 ? 'signed-out' : 'signed-in',
        })
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)
    expect(text(view.container)).toContain('未登录')

    await press(view.container, 'data-opl-refresh')
    expect(calls.filter((call) => call.method === 'minimax-account-status')).toHaveLength(2)
    expect(text(view.container)).toContain('已登录')
  })

  it('reports an unreadable status without claiming signed-out, then recovers on refresh', async () => {
    let reads = 0
    const { call } = fixture(async (method, request) => {
      if (method !== 'minimax-account-status') throw new Error(`unexpected RPC ${method}`)
      reads++
      if (reads === 1) throw new Error('status unavailable')
      return status({ region: request.region, loginState: 'signed-out' })
    })
    const view = await mount(call)
    expect(text(view.container)).toContain('无法读取官方登录状态')
    expect(text(view.container)).not.toContain('未登录')
    expect(disabled(control(view.container, 'data-opl-login'))).toBe(true)
    expect(disabled(control(view.container, 'data-opl-refresh'))).toBe(false)

    await press(view.container, 'data-opl-refresh')
    expect(text(view.container)).toContain('未登录')
    expect(disabled(control(view.container, 'data-opl-login'))).toBe(false)
  })

  it('starts a login, keeps cancel available immediately, and ignores the late login after cancel', async () => {
    const login = deferred<MiniMaxAccountStatus>()
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-status')
        return status({ region: request.region, loginState: 'signed-out' })
      if (method === 'minimax-account-login') return login.promise
      if (method === 'minimax-account-cancel')
        return status({ region: request.region, loginState: 'signed-out' })
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)

    await press(view.container, 'data-opl-login')
    expect(calls.at(-1)).toEqual({
      method: 'minimax-account-login',
      request: { region: 'cn' },
    })
    // The login RPC has not settled, but this page's own attempt is cancellable.
    expect(text(view.container)).toContain('等待官方授权')
    expect(text(view.container)).toContain('等待授权…')
    const cancel = control(view.container, 'data-opl-cancel')
    expect(disabled(cancel)).toBe(false)
    expect(disabled(control(view.container, 'data-opl-login'))).toBe(true)
    expect(has(view.container, 'data-opl-logout')).toBe(false)

    await press(view.container, 'data-opl-cancel')
    expect(calls).toContainEqual({
      method: 'minimax-account-cancel',
      request: { region: 'cn' },
    })
    expect(calls).not.toContainEqual(expect.objectContaining({ method: 'minimax-account-logout' }))
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).toContain('已取消本次官方登录')

    // The cancelled login promise settles later; its success is not this view's.
    await act(async () => {
      login.resolve(status({ region: 'cn', loginState: 'signed-in' }))
    })
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).not.toContain('已登录')
  })

  it('shows signed-in when the login RPC completes successfully', async () => {
    const login = deferred<MiniMaxAccountStatus>()
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-status')
        return status({ region: request.region, loginState: 'signed-out' })
      if (method === 'minimax-account-login') return login.promise
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-login')
    expect(text(view.container)).toContain('等待官方授权')

    await act(async () => {
      login.resolve(status({ region: 'cn', loginState: 'signed-in' }))
    })
    expect(calls).toContainEqual({
      method: 'minimax-account-login',
      request: { region: 'cn' },
    })
    expect(text(view.container)).toContain('已登录')
    expect(text(view.container)).toContain('已登录官方账号')
    expect(has(view.container, 'data-opl-logout')).toBe(true)
    expect(has(view.container, 'data-opl-cancel')).toBe(false)
  })

  it('ignores a late login failure after cancel and does not report it', async () => {
    const login = deferred<MiniMaxAccountStatus>()
    const { call } = fixture(async (method, request) => {
      if (method === 'minimax-account-status')
        return status({ region: request.region, loginState: 'signed-out' })
      if (method === 'minimax-account-login') return login.promise
      if (method === 'minimax-account-cancel')
        return status({ region: request.region, loginState: 'signed-out' })
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-login')
    await press(view.container, 'data-opl-cancel')

    await act(async () => {
      login.reject(new Error('late login failure'))
    })
    expect(text(view.container)).not.toContain('未能确认登录结果')
    expect(text(view.container)).toContain('已取消本次官方登录')
    expect(text(view.container)).toContain('未登录')
  })

  it('re-reads the real state after a failed cancel and still ignores the orphaned login', async () => {
    const login = deferred<MiniMaxAccountStatus>()
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-status')
        return status({ region: request.region, loginState: 'signed-out' })
      if (method === 'minimax-account-login') return login.promise
      if (method === 'minimax-account-cancel') throw new Error('cancel failed')
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-login')
    await press(view.container, 'data-opl-cancel')

    expect(calls.filter((call) => call.method === 'minimax-account-status')).toHaveLength(2)
    expect(text(view.container)).toContain('取消请求未完成，请刷新状态后重试')
    expect(text(view.container)).toContain('未登录')

    await act(async () => {
      login.reject(new Error('late login failure'))
    })
    expect(text(view.container)).not.toContain('未能确认登录结果')
  })

  it('re-reads the real state after a failed login instead of claiming it did nothing', async () => {
    let reads = 0
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-status') {
        reads++
        return status({
          region: request.region,
          loginState: reads === 1 ? 'signed-out' : 'signed-in',
        })
      }
      if (method === 'minimax-account-login') throw new Error('unconfirmed')
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-login')

    expect(calls.filter((call) => call.method === 'minimax-account-status')).toHaveLength(2)
    expect(text(view.container)).toContain('已登录官方账号')
    expect(text(view.container)).toContain('已登录')
  })

  it('re-reads the real state after a failed sign-out and reports the surviving state', async () => {
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-status')
        return status({ region: request.region, loginState: 'signed-in' })
      if (method === 'minimax-account-logout') throw new Error('unconfirmed')
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-logout')

    expect(calls.filter((call) => call.method === 'minimax-account-status')).toHaveLength(2)
    expect(text(view.container)).toContain('重新读取后仍为已登录')
    expect(text(view.container)).toContain('已登录')
    expect(text(view.container)).not.toContain('已退出官方账号')
  })

  it('does not let a login started in cn overwrite the global view after switching region', async () => {
    const login = deferred<MiniMaxAccountStatus>()
    const { call } = fixture(async (method, request) => {
      if (method === 'minimax-account-status')
        return status({ region: request.region, loginState: 'signed-out' })
      if (method === 'minimax-account-login') return login.promise
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-login')
    expect(text(view.container)).toContain('等待官方授权')

    await chooseRegion(view.container, 'global')
    expect(text(view.container)).toContain('另一地区正在等待官方授权')
    expect(control(view.container, 'data-opl-region-select').value).toBe('global')

    // The cn login belongs to the previous region; its late success is not global.
    await act(async () => {
      login.resolve(status({ region: 'cn', loginState: 'signed-in' }))
    })
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).not.toContain('已登录')
    expect(has(view.container, 'data-opl-other-pending')).toBe(false)

    await chooseRegion(view.container, 'cn')
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).not.toContain('已登录')
  })

  it('switches to the region that owns a pending authorization and cancels only there', async () => {
    const { call, calls } = fixture(async (method, request) => {
      if (method === 'minimax-account-status')
        return request.region === 'cn'
          ? status({
              region: 'cn',
              loginState: 'signed-out',
              loginPending: true,
              pendingRegion: 'cn',
              loginDeadline: Date.now() + 9 * 60_000,
            })
          : status({
              region: 'global',
              loginState: 'signed-out',
              loginPending: true,
              pendingRegion: 'cn',
              loginDeadline: Date.now() + 9 * 60_000,
            })
      if (method === 'minimax-account-cancel')
        return status({ region: request.region, loginState: 'signed-out' })
      throw new Error(`unexpected RPC ${method}`)
    })
    const view = await mount(call)
    expect(has(view.container, 'data-opl-cancel')).toBe(true)
    expect(text(view.container)).toContain('等待授权（剩余约')

    await chooseRegion(view.container, 'global')
    expect(has(view.container, 'data-opl-cancel')).toBe(false)
    const other = control(view.container, 'data-opl-other-pending')
    expect(other.textContent).toContain('另一地区正在等待官方授权')
    const switchRegion = control(view.container, 'data-opl-switch-region')
    await act(async () => {
      switchRegion.click()
    })
    expect(control(view.container, 'data-opl-region-select').value).toBe('cn')
    expect(has(view.container, 'data-opl-cancel')).toBe(true)
    expect(calls.some((call) => call.method === 'minimax-account-cancel')).toBe(false)
  })

  it('ignores a status answer from a previous call object', async () => {
    const first = deferred<MiniMaxAccountStatus>()
    const firstCall = fixture(() => first.promise).call
    const secondCall = fixture(async (_method, request) =>
      status({ region: request.region, loginState: 'signed-out' }),
    ).call
    const view = await mount(firstCall)

    await act(async () => {
      view.root.render(
        React.createElement(MiniMaxAccountSection, {
          call: secondCall,
          t: (key: keyof typeof minimaxAccountZh) => minimaxAccountZh[key],
        }),
      )
    })
    expect(text(view.container)).toContain('未登录')

    await act(async () => {
      first.resolve(status({ region: 'cn', loginState: 'signed-in' }))
    })
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).not.toContain('已登录')
  })

  it('polls only while authorization is pending and clears the timer on unmount', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const { call } = fixture(async (_method, request) =>
      status({
        region: request.region,
        loginPending: true,
        pendingRegion: request.region,
        loginDeadline: Date.now() + 5 * 60_000,
      }),
    )
    const view = await mount(call)
    const timer = setIntervalSpy.mock.calls.find((call) => call[1] === 2000)
    expect(timer, 'pending authorization should schedule a 2s poll').toBeDefined()
    await act(async () => {
      view.root.unmount()
    })
    roots.splice(roots.indexOf(view.root), 1)
    expect(clearIntervalSpy).toHaveBeenCalled()
  })

  it('does not poll an ordinary signed-out state', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const { call } = fixture(async (_method, request) =>
      status({ region: request.region, loginState: 'signed-out' }),
    )
    await mount(call)
    expect(setIntervalSpy.mock.calls.some((call) => call[1] === 2000)).toBe(false)
  })

  it('logout completion does not strand a concurrent refresh spinner', async () => {
    const logout = deferred<MiniMaxAccountStatus>()
    const refresh = deferred<MiniMaxAccountStatus>()
    let reads = 0
    const { call } = fixture(async (method) => {
      if (method === 'minimax-account-status')
        return ++reads === 1 ? status({ loginState: 'signed-in' }) : refresh.promise
      if (method === 'minimax-account-logout') return logout.promise
      throw Error('unexpected RPC')
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-logout')
    await press(view.container, 'data-opl-refresh')

    // Logout finishes first and advances the epoch; the refresh answer is stale,
    // but the refresh still owns the spinner it turned on and must clear it.
    await act(async () => {
      logout.resolve(status({ loginState: 'signed-out' }))
    })
    await act(async () => {
      refresh.resolve(status({ loginState: 'signed-in' }))
    })
    expect(disabled(control(view.container, 'data-opl-refresh'))).toBe(false)
    expect(disabled(control(view.container, 'data-opl-login'))).toBe(false)
    expect(has(view.container, 'data-opl-logout')).toBe(false)
    expect(text(view.container)).toContain('未登录')
  })

  it('cancel completion does not strand a concurrent refresh spinner', async () => {
    const refresh = deferred<MiniMaxAccountStatus>()
    const cancel = deferred<MiniMaxAccountStatus>()
    const cancelRead = deferred<MiniMaxAccountStatus>()
    let reads = 0
    const { call } = fixture(async (method, request) => {
      if (method === 'minimax-account-status') {
        reads++
        if (reads === 1)
          return status({
            region: request.region,
            loginPending: true,
            pendingRegion: request.region,
            loginDeadline: Date.now() + 9 * 60_000,
          })
        return reads === 2 ? refresh.promise : cancelRead.promise
      }
      if (method === 'minimax-account-cancel') return cancel.promise
      throw Error('unexpected RPC')
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-refresh')
    await press(view.container, 'data-opl-cancel')

    // Cancel starts its own confirming read before the earlier refresh settles.
    await act(async () => {
      cancel.resolve(status({ loginState: 'signed-out' }))
    })
    await act(async () => {
      refresh.resolve(status({ loginState: 'signed-in' }))
    })
    await act(async () => {
      cancelRead.resolve(status({ loginState: 'signed-out' }))
    })
    expect(disabled(control(view.container, 'data-opl-refresh'))).toBe(false)
    expect(disabled(control(view.container, 'data-opl-login'))).toBe(false)
    expect(has(view.container, 'data-opl-cancel')).toBe(false)
    expect(text(view.container)).toContain('未登录')
  })

  it('does not let a late old-region refresh clear the new region spinner', async () => {
    const cnRefresh = deferred<MiniMaxAccountStatus>()
    const globalRead = deferred<MiniMaxAccountStatus>()
    let reads = 0
    const { call } = fixture(async (method, request) => {
      if (method !== 'minimax-account-status') throw Error('unexpected RPC')
      reads++
      if (reads === 1) return status({ region: request.region, loginState: 'signed-out' })
      return request.region === 'cn' ? cnRefresh.promise : globalRead.promise
    })
    const view = await mount(call)
    await press(view.container, 'data-opl-refresh')
    await chooseRegion(view.container, 'global')

    // The cn refresh is stale, but it must not clear the global read's spinner.
    await act(async () => {
      cnRefresh.resolve(status({ region: 'cn', loginState: 'signed-in' }))
    })
    expect(disabled(control(view.container, 'data-opl-refresh'))).toBe(true)

    await act(async () => {
      globalRead.resolve(status({ region: 'global', loginState: 'signed-out' }))
    })
    expect(disabled(control(view.container, 'data-opl-refresh'))).toBe(false)
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).not.toContain('已登录')
  })

  it('does not let a late read from a previous call clear the new call spinner', async () => {
    const firstRead = deferred<MiniMaxAccountStatus>()
    const secondRead = deferred<MiniMaxAccountStatus>()
    const firstCall = fixture(() => firstRead.promise).call
    const secondCall = fixture(() => secondRead.promise).call
    const view = await mount(firstCall)

    await act(async () => {
      view.root.render(
        React.createElement(MiniMaxAccountSection, {
          call: secondCall,
          t: (key: keyof typeof minimaxAccountZh) => minimaxAccountZh[key],
        }),
      )
    })
    await act(async () => {
      firstRead.resolve(status({ loginState: 'signed-in' }))
    })
    expect(disabled(control(view.container, 'data-opl-refresh'))).toBe(true)

    await act(async () => {
      secondRead.resolve(status({ loginState: 'signed-out' }))
    })
    expect(disabled(control(view.container, 'data-opl-refresh'))).toBe(false)
    expect(text(view.container)).toContain('未登录')
    expect(text(view.container)).not.toContain('已登录')
  })

  it('does not overlap a slow quiet poll and applies it before the next one', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const slowFirst = deferred<MiniMaxAccountStatus>()
    const slowSecond = deferred<MiniMaxAccountStatus>()
    let reads = 0
    const { call, calls } = fixture(async (method, request) => {
      if (method !== 'minimax-account-status') throw Error('unexpected RPC')
      reads++
      if (reads === 1)
        return status({
          region: request.region,
          loginPending: true,
          pendingRegion: request.region,
          loginDeadline: Date.now() + 9 * 60_000,
        })
      return reads === 2 ? slowFirst.promise : slowSecond.promise
    })
    const view = await mount(call)
    const timer = setIntervalSpy.mock.calls.find((call) => call[1] === 2000)
    expect(timer, 'pending authorization should schedule a 2s poll').toBeDefined()
    const tick = timer![0] as () => void

    await act(async () => {
      tick()
    })
    expect(calls.filter((call) => call.method === 'minimax-account-status')).toHaveLength(2)
    // A slow poll is still in flight; the next 2s tick must not start a rival
    // read that would invalidate it.
    await act(async () => {
      tick()
    })
    expect(calls.filter((call) => call.method === 'minimax-account-status')).toHaveLength(2)

    await act(async () => {
      slowFirst.resolve(
        status({
          loginPending: true,
          pendingRegion: 'cn',
          loginDeadline: Date.now() + 8 * 60_000,
        }),
      )
    })
    expect(text(view.container)).toContain('等待官方授权')

    // Only after the first poll settled may the next tick start another one.
    await act(async () => {
      tick()
    })
    expect(calls.filter((call) => call.method === 'minimax-account-status')).toHaveLength(3)
    await act(async () => {
      slowSecond.resolve(status({ loginState: 'signed-in' }))
    })
    expect(text(view.container)).toContain('已登录')
    expect(has(view.container, 'data-opl-cancel')).toBe(false)
  })
})

it('chief: login completion does not strand a concurrent refresh spinner', async () => {
  const login = deferred<MiniMaxAccountStatus>()
  const refresh = deferred<MiniMaxAccountStatus>()
  let reads = 0
  const { call } = fixture(async (method) => {
    if (method === 'minimax-account-status') return ++reads === 1 ? status() : refresh.promise
    if (method === 'minimax-account-login') return login.promise
    throw Error('unexpected RPC')
  })
  const view = await mount(call)
  await press(view.container, 'data-opl-login')
  await press(view.container, 'data-opl-refresh')
  await act(async () => {
    login.resolve(status({ loginState: 'signed-in' }))
  })
  await act(async () => {
    refresh.resolve(status())
  })
  expect(disabled(control(view.container, 'data-opl-refresh'))).toBe(false)
  expect(disabled(control(view.container, 'data-opl-logout'))).toBe(false)
})
