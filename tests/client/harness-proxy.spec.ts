/**
 * Per-Harness network proxy in 设置 → 执行与组合 → 执行引擎与网络代理.
 *
 * These tests drive the real `HarnessSettings` — the settings surface the user
 * actually opens — through the same minimal DOM as the sibling client specs, and only
 * through public behaviour: choosing a mode, typing an address, pressing 保存代理,
 * and the OPL RPC calls that result. Nothing asserts on hook internals, and no
 * implementation is mirrored here.
 *
 * They pin the product decisions that matter to a user:
 *  - every external Harness (Codex CLI, Claude Code, Grok Build, MiniMax, any other
 *    registered CLI) gets its own 继承环境 / 直连 / 指定代理 choice, saved only when
 *    that row's own button is pressed, and one row's save never edits another's;
 *  - the built-in DSH Harness runs in the desktop process, so its row cannot be set
 *    and says so;
 *  - only a credential-free http/https address is accepted, and a refused address is
 *    reported without quoting the address back;
 *  - a failed or out-of-order save says so instead of claiming the settings changed.
 */
import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { ReactNode } from 'react'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  // The published primitives package is not loadable from this offline install, so the
  // two atoms this section uses are stood in for. Both pass their props straight
  // through, which is what the desktop composition relies on anyway.
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    React.createElement('button', { ...props, type: 'button' }, children),
  Switch: ({
    label,
    checked,
    onChange,
    ...props
  }: {
    label?: string
    checked?: boolean
    onChange?: (checked: boolean) => void
  } & Record<string, unknown>) =>
    React.createElement(
      'button',
      { ...props, role: 'switch', 'aria-checked': checked, onClick: () => onChange?.(!checked) },
      label,
    ),
}))

// `./dom.ts` installs the process DOM on import, before React DOM is loaded.
const dom = createTestDom()
const { act } = React
const { HarnessSettings } = await import('../../src/execution/client/HarnessSettings.tsx')
const { ExecutionCatalogSection } = await import(
  '../../src/execution/client/ExecutionCatalogSection.tsx'
)
const { ExecutionSettings } = await import('../../src/execution/client/ExecutionSettings.tsx')
const { createRoot } = await import('react-dom/client')

type Node = {
  nodeName: string
  textContent: string | null
  childNodes: Node[]
  parentNode: Node | null
  value: string
  checked: boolean
  click: () => boolean
  dispatchEvent: (type: string) => boolean
  getAttribute: (name: string) => string | null
}

/**
 * Give the shared DOM shim the three things this section needs and the shim does not
 * model. Only elements created by the process DOM are touched, and no component or
 * production code changes.
 *
 *  - bubbling listeners, so a click reaches React's delegated root handler;
 *  - `input.type` reflecting its attribute, which React reads to decide whether an
 *    element is a radio;
 *  - the `value` property jsdom gives elements, so a typed address can be read back.
 *
 * There is deliberately no `checked` property: React installs its own tracker for one,
 * and supplying a second breaks the radio path it drives.
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
  const dispatch = function (type: string, target: object): boolean {
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
  Object.defineProperty(proto, 'type', {
    get(this: Node) {
      return this.getAttribute('type') ?? ''
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
  // `select.options` is the collection React walks when a select takes a value.
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
/** The one control carrying `attribute="id"` inside `scope`. */
function control(scope: unknown, attribute: string, id: string): Node {
  const found = walk(scope).find((node) => node.getAttribute?.(attribute) === id)
  expect(found, `找不到 ${attribute}=${id}`).toBeDefined()
  return found!
}
/** The row rendering one Harness's proxy choices. */
const row = (container: unknown, id: string) => control(container, 'data-opl-proxy-row', id)
/** The three mode radios, in the order the section offers them. */
const modeRadios = (scope: Node) =>
  walk(scope).filter((node) => node.nodeName === 'INPUT' && node.getAttribute('type') === 'radio')
const text = (scope: unknown) => (scope as Node).textContent ?? ''

/** Choose 继承环境 / 直连 / 指定代理 by the label the user reads. */
async function chooseMode(scope: Node, label: string) {
  const radio = modeRadios(scope).find((item) => item.value === modeOf(label))
  expect(radio, `找不到代理方式「${label}」`).toBeDefined()
  await act(async () => {
    radio!.checked = true
    radio!.dispatchEvent('click')
  })
}
const modeOf = (label: string) =>
  ({ 继承环境: 'inherit', 直连: 'direct', 指定代理: 'custom' })[label] ?? label

async function typeAddress(scope: Node, id: string, address: string) {
  const input = control(scope, 'data-opl-proxy-url', id)
  await act(async () => {
    input.value = address
  })
}
async function press(node: Node) {
  await act(async () => {
    node.click()
  })
}
const saveButton = (scope: Node, id: string) => control(scope, 'data-opl-proxy-save', id)
const addressOf = (scope: Node, id: string) => control(scope, 'data-opl-proxy-url', id).value

type Harness = { id: string; name: string; kind: string; command?: string; proxy?: unknown }
/** The catalogue as the Host projects it: a built-in DSH plus the registered external CLIs. */
function catalog(proxies: Record<string, unknown> = {}) {
  return {
    version: 2,
    models: [
      {
        ref: { provider: 'minimax-official', model: 'MiniMax-M3.1-Flash' },
        name: 'MiniMax-M3.1-Flash',
        source: 'MiniMax 官方账号（mcode）',
        available: true,
      },
    ],
    harnesses: [
      { id: 'dsh', name: 'DSH', kind: 'dsh', adapter: 'native-session' },
      { id: 'codex', name: 'Codex CLI', kind: 'acp', command: 'codex' },
      { id: 'claude', name: 'Claude Code', kind: 'acp', command: 'claude' },
      { id: 'grok-build', name: 'Grok Build', kind: 'grok-build', adapter: 'acp-v1' },
      { id: 'minimax-code', name: 'MiniMax Code', kind: 'acp', command: 'mcode' },
      { id: 'custom-cli', name: '自建 CLI', kind: 'acp', command: 'my-cli --serve' },
    ].map((harness) => ({
      ...harness,
      ...(harness.id in proxies ? { proxy: proxies[harness.id] } : {}),
    })),
    combinations: [
      {
        id: 'codex/one',
        name: 'Codex 组合',
        modelRef: { provider: 'minimax-official', model: 'MiniMax-M3.1-Flash' },
        harnessRef: 'codex',
        permissionPolicy: 'full-access',
        isDefault: true,
        enabled: true,
      },
      {
        id: 'inactive/one',
        name: '可启用但未启用',
        modelRef: { provider: 'minimax-official', model: 'MiniMax-M3.1-Flash' },
        harnessRef: 'custom-cli',
        permissionPolicy: 'read-only',
        isDefault: false,
        enabled: false,
      },
    ],
  }
}
type Calls = { method: string; args: unknown }[]
/** RPC stub over a catalog the stub itself owns, so re-opening reads back what was saved. */
function fixture(start: ReturnType<typeof catalog>, save?: (next: any) => unknown) {
  const calls: Calls = []
  // The wire carries JSON, so the stub round-trips exactly like the real transport.
  let stored = JSON.parse(JSON.stringify(start))
  const call = (async (method: string, args?: unknown) => {
    calls.push({ method, args })
    if (method === 'harness-installations')
      return stored.harnesses.map((definition: Harness) => ({
        id: definition.id,
        name: definition.name,
        installed: true,
        runnable: true,
        instructions: '',
        website: '',
        definition: JSON.parse(JSON.stringify(definition)),
      }))
    if (method === 'catalog') return JSON.parse(JSON.stringify(stored))
    if (method === 'save-catalog') {
      stored = JSON.parse(JSON.stringify((args as { catalog: unknown }).catalog))
      return JSON.parse(JSON.stringify(stored))
    }
    if (method === 'combinations')
      return stored.combinations.map((item: { id: string }) => ({ id: item.id, available: true }))
    if (method === 'save-harness-proxy') {
      const request = args as { harnessId: string; proxy: unknown }
      const next = {
        ...stored,
        harnesses: stored.harnesses.map((h: Harness) =>
          h.id === request.harnessId ? { ...h, proxy: request.proxy } : h,
        ),
      }
      const verdict = save?.(next)
      if (verdict instanceof Error) throw verdict
      if (verdict instanceof Promise) await verdict
      stored = JSON.parse(JSON.stringify(next))
      return JSON.parse(JSON.stringify(stored))
    }
    throw new Error(`unexpected RPC ${method}`)
  }) as unknown as ExecutionCall
  const saves = () => calls.filter((entry) => entry.method === 'save-harness-proxy')
  const saved = () => ({ catalog: stored as ReturnType<typeof catalog> })
  const harnessOf = (sent: { harnesses: Harness[] }, id: string): Harness =>
    sent.harnesses.find((item) => item.id === id)!
  return { call, calls, saves, saved, harnessOf, stored: () => stored }
}
/** The stored catalog, read back over the same RPC the settings page uses. */
const readCatalog = (call: ExecutionCall) => call('catalog') as Promise<ReturnType<typeof catalog>>

const mounted: Array<() => Promise<void>> = []
afterEach(async () => {
  while (mounted.length) await mounted.pop()!()
})
/** Open the execution settings surface and let the catalog load. */
async function open(call: ExecutionCall, component = HarnessSettings) {
  const container = dom.container()
  const root = createRoot(container as unknown as Element)
  mounted.push(() =>
    act(async () => {
      root.unmount()
    }),
  )
  await act(async () => {
    root.render(React.createElement(component as never, { call }))
  })
  return container
}

describe('每个外部 Harness 独立的代理设置', () => {
  it('先选模型后仅列出适配的 Harness，切换模型会清除旧 Harness', async () => {
    const data = {
      ...catalog(),
      supportedPairings: [
        { modelRef: catalog().models[0].ref, harnessRefs: ['minimax-code', 'codex'] },
        { modelRef: { provider: 'opl-gateway', model: 'codex::gpt-test' }, harnessRefs: ['codex'] },
      ],
    }
    data.models.push({
      ref: data.supportedPairings[1].modelRef,
      name: 'GPT',
      source: 'OPL',
      available: true,
    })
    const { call, calls } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    const manual = walk(view).find(
      (node) => node.getAttribute?.('data-opl-panel') === 'custom-combinations',
    )!
    const selects = () => walk(manual).filter((node) => node.nodeName === 'SELECT')
    expect(text(selects()[1])).toBe('先选择模型')
    await act(async () => {
      selects()[0].value = JSON.stringify(['minimax-official', 'MiniMax-M3.1-Flash'])
      selects()[0].dispatchEvent('change')
    })
    expect(text(selects()[1])).toContain('MiniMax Code')
    expect(text(selects()[1])).not.toContain('Codex CLI')
    await act(async () => {
      selects()[1].value = 'minimax-code'
      selects()[1].dispatchEvent('change')
    })
    await act(async () => {
      selects()[0].value = JSON.stringify(['opl-gateway', 'codex::gpt-test'])
      selects()[0].dispatchEvent('change')
    })
    expect(text(selects()[1])).toContain('Codex CLI')
    expect(text(selects()[1])).not.toContain('MiniMax Code')
    expect(
      walk(selects()[1])
        .find(
          (node) => node.nodeName === 'OPTION' && (node as Node & { selected: boolean }).selected,
        )
        ?.getAttribute('value'),
    ).toBe('')
    expect(calls.some((entry) => entry.method === 'save-catalog')).toBe(false)
  })

  it('手动添加只选模型与 Harness，名称自动生成且可在管理列表修改', async () => {
    const initial = catalog()
    const data = {
      ...initial,
      supportedPairings: [{ modelRef: initial.models[0].ref, harnessRefs: ['minimax-code'] }],
    }
    const { call, stored } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    const manual = walk(view).find(
      (node) => node.getAttribute?.('data-opl-panel') === 'custom-combinations',
    )!
    expect(walk(manual).some((node) => node.nodeName === 'INPUT')).toBe(false)
    const selects = walk(manual).filter((node) => node.nodeName === 'SELECT')
    await act(async () => {
      selects[0].value = JSON.stringify(['minimax-official', 'MiniMax-M3.1-Flash'])
      selects[0].dispatchEvent('change')
    })
    await act(async () => {
      selects[1].value = 'minimax-code'
      selects[1].dispatchEvent('change')
    })
    await press(walk(manual).find((node) => node.nodeName === 'BUTTON')!)
    expect(stored().combinations.at(-1)).toMatchObject({
      name: 'MiniMax-M3.1-Flash + MiniMax Code',
      enabled: true,
      permissionPolicy: 'workspace',
    })
    const added = walk(view).find(
      (node) => node.getAttribute?.('data-opl-combination') === stored().combinations.at(-1).id,
    )!
    expect(walk(added).some((node) => node.nodeName === 'INPUT')).toBe(true)
  })

  it('按 Harness 全选和取消只影响本组，逐项取消后只保存剩余勾选', async () => {
    const initial = catalog()
    const data = {
      ...initial,
      models: [
        ...initial.models,
        ...['big-pickle', 'beam', 'other'].map((model) => ({
          ref: { provider: 'our-free-model', model },
          name: model,
          source: 'Our Free Model',
          available: true,
        })),
      ],
      recommendations: [
        {
          modelRef: { provider: 'our-free-model', model: 'big-pickle' },
          harnessRef: 'opencode',
          name: 'Pickle',
        },
        {
          modelRef: { provider: 'our-free-model', model: 'beam' },
          harnessRef: 'opencode',
          name: 'Beam',
        },
        {
          modelRef: { provider: 'our-free-model', model: 'other' },
          harnessRef: 'pi',
          name: 'Other',
        },
      ],
    }
    const { call, calls, stored } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    const group = (id: string) =>
      walk(view).find((node) => node.getAttribute?.('data-opl-recommendation-group') === id)!
    const check = async (node: Node, value: boolean) =>
      act(async () => {
        node.checked = value
        node.click()
      })
    await check(group('opencode'), true)
    expect(group('pi').checked).toBe(false)
    await check(group('pi'), true)
    await check(group('opencode'), false)
    expect(group('pi').checked).toBe(true)
    await check(group('opencode'), true)
    await check(
      walk(view).find((node) =>
        node.getAttribute?.('data-opl-recommendation-item')?.includes('beam'),
      )!,
      false,
    )
    expect(group('opencode').checked).toBe(false)
    expect((group('opencode') as Node & { indeterminate: boolean }).indeterminate).toBe(true)
    expect(calls.some((entry) => entry.method === 'save-catalog')).toBe(false)
    await press(
      walk(view).find((node) => node.nodeName === 'BUTTON' && text(node).startsWith('保存选择'))!,
    )
    expect(
      stored()
        .combinations.slice(initial.combinations.length)
        .map((item: { name: string }) => item.name),
    ).toEqual(['Pickle', 'Other'])
    expect(calls.filter((entry) => entry.method === 'save-catalog')).toHaveLength(1)
  })

  it('批量推荐一次保存并跳过已有或重复组合，不改变已有权限和默认项', async () => {
    const initial = catalog()
    const recommendation = {
      modelRef: { provider: 'our-free-model', model: 'big-pickle' },
      harnessRef: 'opencode',
      name: 'Big Pickle + OpenCode',
    }
    const data = {
      ...initial,
      models: [
        ...initial.models,
        ...['big-pickle', 'beam'].map((model) => ({
          ref: { provider: 'our-free-model', model },
          name: model,
          source: 'Our Free Model',
          available: true,
        })),
      ],
      recommendations: [
        recommendation,
        recommendation,
        { ...recommendation, modelRef: { ...recommendation.modelRef, model: 'beam' } },
        { ...initial.combinations[0] },
      ],
    }
    const { call, calls, stored } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    const button = () =>
      walk(view).find((node) => node.nodeName === 'BUTTON' && text(node).startsWith('保存选择'))!
    expect(calls.some((entry) => entry.method === 'save-catalog')).toBe(false)
    await press(walk(view).find((node) => node.nodeName === 'BUTTON' && text(node) === '全选')!)
    await press(button())
    expect(calls.filter((entry) => entry.method === 'save-catalog')).toHaveLength(1)
    expect(stored().combinations.slice(0, initial.combinations.length)).toEqual(
      initial.combinations.map((item) =>
        item.enabled
          ? item
          : {
              ...item,
              enabled: true,
              generated: false,
              autoEnabled: false,
              autoEnabledDisabled: true,
            },
      ),
    )
    const additions = stored().combinations.slice(initial.combinations.length)
    expect(additions).toHaveLength(2)
    expect(new Set(additions.map((item: { id: string }) => item.id)).size).toBe(2)
    for (const item of additions)
      expect(item).toMatchObject({
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
        autoEnabled: false,
        autoEnabledDisabled: true,
      })
    await press(button())
    expect(calls.filter((entry) => entry.method === 'save-catalog')).toHaveLength(1)
    await press(walk(view).find((node) => node.nodeName === 'BUTTON' && text(node) === '取消全选')!)
    await press(button())
    expect(stored().combinations).toHaveLength(initial.combinations.length + 2)
    expect(stored().combinations[0]).toMatchObject({
      ...initial.combinations[0],
      enabled: false,
      generated: false,
      autoEnabled: false,
      autoEnabledDisabled: true,
    })
    expect(stored().combinations[1]).toMatchObject({
      ...initial.combinations[1],
      generated: false,
      autoEnabled: false,
      autoEnabledDisabled: true,
    })
    expect(stored().combinations.every((item: { enabled: boolean }) => !item.enabled)).toBe(true)
    await press(walk(view).find((node) => node.nodeName === 'BUTTON' && text(node) === '全选')!)
    await press(button())
    expect(stored().combinations).toHaveLength(initial.combinations.length + 2)
    expect(stored().combinations[0]).toMatchObject({
      permissionPolicy: initial.combinations[0].permissionPolicy,
      isDefault: initial.combinations[0].isDefault,
      enabled: true,
    })
  })

  it('推荐选择和手动添加表单分开，批量保存不依赖手动表单', async () => {
    const data = {
      ...catalog(),
      recommendations: [
        {
          modelRef: { provider: 'our-free-model', model: 'big-pickle' },
          harnessRef: 'opencode',
          name: 'Big Pickle + OpenCode',
        },
      ],
    }
    data.models.push({
      ref: data.recommendations[0].modelRef,
      name: 'Big Pickle',
      source: 'OFM',
      available: true,
    })
    const { call, calls } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    const manual = walk(view).find(
      (node) => node.getAttribute?.('data-opl-panel') === 'custom-combinations',
    )!
    const recommended = walk(view).find(
      (node) => node.getAttribute?.('data-opl-panel') === 'recommended-combinations',
    )!
    expect(walk(manual).some((node) => node.getAttribute?.('data-opl-recommendation-group'))).toBe(
      false,
    )
    expect(walk(recommended).some((node) => node.nodeName === 'SELECT')).toBe(false)
    expect(
      walk(view).some((node) => node.getAttribute?.('data-opl-recommendation') === 'true'),
    ).toBe(false)
    expect(calls.some((entry) => entry.method === 'save-catalog')).toBe(false)
    await press(
      walk(recommended).find((node) => node.nodeName === 'BUTTON' && text(node) === '全选')!,
    )
    expect(walk(manual).some((node) => node.nodeName === 'INPUT')).toBe(false)
    await press(
      walk(recommended).find(
        (node) => node.nodeName === 'BUTTON' && text(node).startsWith('保存选择'),
      )!,
    )
    const saved = calls.find((entry) => entry.method === 'save-catalog')!.args as {
      catalog: {
        combinations: Array<{
          name: string
          harnessRef: string
          generated?: boolean
          permissionPolicy: string
        }>
      }
    }
    expect(saved.catalog.combinations.at(-1)).toMatchObject({
      name: 'Big Pickle + OpenCode',
      harnessRef: 'opencode',
      permissionPolicy: 'workspace',
    })
    expect(saved.catalog.combinations.at(-1)?.generated).not.toBe(true)
  })

  it('把组合、执行程序、代理和工具审批收拢在一个设置入口内', async () => {
    const { call } = fixture(catalog())
    const view = await open(call, ExecutionSettings)
    const panels = walk(view)
      .map((node) => node.getAttribute?.('data-opl-panel'))
      .filter(Boolean)
    expect(panels).toContain('execution')
    expect(panels).toContain('catalog')
    expect(panels).toContain('execution-settings')
    expect(panels).toContain('auto-review')
  })

  it('代理配置归执行引擎，组合页面不再重复提供且检测不读取模型目录', async () => {
    const { call, calls } = fixture(catalog())
    const view = await open(call)
    expect(row(view, 'codex')).toBeTruthy()
    expect(calls.some(({ method }) => method === 'catalog' || method === 'combinations')).toBe(
      false,
    )
    const combinations = await open(call, ExecutionCatalogSection)
    expect(walk(combinations).some((node) => node.getAttribute?.('data-opl-proxy-row'))).toBe(false)
  })

  it('仅在上方选择启停，停用后从下方隐藏并保留原配置以供恢复', async () => {
    const initial = catalog()
    const { call, stored } = fixture(initial)
    const view = await open(call, ExecutionCatalogSection)
    const rows = () => walk(view).filter((node) => node.getAttribute?.('data-opl-combination'))
    expect(rows().map((node) => node.getAttribute('data-opl-combination'))).toEqual(['codex/one'])
    expect(walk(rows()[0]).filter((node) => node.getAttribute?.('role') === 'switch')).toHaveLength(
      0,
    )
    const choice = () =>
      walk(view).find((node) =>
        node.getAttribute?.('data-opl-recommendation-item')?.includes('inactive/one'),
      )!
    expect(choice().checked).toBe(false)
    await act(async () => {
      choice().checked = true
      choice().click()
    })
    expect(rows()).toHaveLength(1)
    const save = () =>
      walk(view).find((node) => node.nodeName === 'BUTTON' && text(node).startsWith('保存选择'))!
    await press(save())
    expect(rows()).toHaveLength(2)
    expect(stored().combinations[1]).toMatchObject({ ...initial.combinations[1], enabled: true })
    await act(async () => {
      choice().checked = false
      choice().click()
    })
    await press(save())
    expect(rows()).toHaveLength(1)
    expect(stored().combinations[1]).toMatchObject(initial.combinations[1])
    expect(stored().combinations).toHaveLength(2)
    await act(async () => {
      choice().checked = true
      choice().click()
    })
    await press(save())
    expect(rows()).toHaveLength(2)
    expect(stored().combinations[1].id).toBe('inactive/one')
  })

  it('相同模型和 Harness 的两份配置可独立选择，不因推荐重复新增', async () => {
    const initial = catalog()
    const existing = initial.combinations[0]
    const data = {
      ...initial,
      combinations: [
        existing,
        {
          ...existing,
          id: 'copy',
          name: '另一份配置',
          enabled: false,
          permissionPolicy: 'read-only',
        },
      ],
      recommendations: [{ ...existing }],
    }
    const { call, stored } = fixture(data as ReturnType<typeof catalog>)
    const view = await open(call, ExecutionCatalogSection)
    const inputs = () =>
      walk(view).filter((node) => node.getAttribute?.('data-opl-recommendation-item'))
    expect(inputs()).toHaveLength(2)
    const copy = inputs().find((node) =>
      node.getAttribute('data-opl-recommendation-item')?.includes('copy'),
    )!
    await act(async () => {
      copy.checked = true
      copy.click()
    })
    const first = inputs().find((node) =>
      node.getAttribute('data-opl-recommendation-item')?.includes('codex/one'),
    )!
    await act(async () => {
      first.checked = false
      first.click()
    })
    await press(
      walk(view).find((node) => node.nodeName === 'BUTTON' && text(node).startsWith('保存选择'))!,
    )
    expect(stored().combinations).toHaveLength(2)
    expect(stored().combinations.map((item: { enabled: boolean }) => item.enabled)).toEqual([
      false,
      true,
    ])
    expect(stored().combinations[0].permissionPolicy).toBe('full-access')
    expect(stored().combinations[1].permissionPolicy).toBe('read-only')
  })

  it('单一组合仅显示名称和来源，不显示默认状态或可执行标签', async () => {
    const { call } = fixture(catalog())
    const view = await open(call, ExecutionCatalogSection)
    const active = walk(view).find(
      (node) => node.getAttribute?.('data-opl-combination') === 'codex/one',
    )!
    const summary = walk(active).find((node) => node.nodeName === 'SUMMARY')!
    expect(text(summary)).toContain('Codex 组合')
    expect(text(summary)).toContain('MiniMax 官方账号')
    expect(text(summary)).not.toContain('默认')
    expect(text(summary)).not.toContain('可执行')
    expect(text(summary)).not.toContain('自定义')
    expect(
      walk(view).some((node) => node.getAttribute?.('data-opl-combination') === 'inactive/one'),
    ).toBe(false)
  })

  it('单一组合未设置默认标记也不显示非默认，且不修改保存标记', async () => {
    const initial = catalog()
    initial.combinations[0].isDefault = false
    const { call, calls, stored } = fixture(initial)
    const view = await open(call, ExecutionCatalogSection)
    const row = walk(view).find(
      (node) => node.getAttribute?.('data-opl-combination') === 'codex/one',
    )!
    expect(text(walk(row).find((node) => node.nodeName === 'SUMMARY')!)).not.toContain('默认')
    expect(walk(row).some((node) => node.getAttribute?.('role') === 'switch')).toBe(false)
    expect(stored().combinations[0].isDefault).toBe(false)
    expect(calls.some((entry) => entry.method === 'save-catalog')).toBe(false)
  })

  it('仅同一模型有多个已启用组合时提供默认组合开关', async () => {
    const initial = catalog()
    const data = {
      ...initial,
      combinations: initial.combinations.map((item) => ({ ...item, enabled: true })),
    }
    const { call, stored } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    const target = walk(view).find(
      (node) => node.getAttribute?.('data-opl-combination') === 'inactive/one',
    )!
    const switches = walk(target).filter((node) => node.getAttribute?.('role') === 'switch')
    expect(switches).toHaveLength(1)
    expect(text(walk(target).find((node) => node.nodeName === 'SUMMARY')!)).toContain('非默认')
    await press(switches[0])
    expect(text(walk(target).find((node) => node.nodeName === 'SUMMARY')!)).not.toContain('非默认')
    expect(stored().combinations.map((item: { isDefault: boolean }) => item.isDefault)).toEqual([
      false,
      true,
    ])
  })

  it('编辑官方配对的默认项或名称后仍留在官方分组', async () => {
    const initial = catalog()
    const ref = initial.models[0].ref
    const data = {
      ...initial,
      combinations: [
        { ...initial.combinations[0], harnessRef: 'minimax-code', generated: true },
        {
          ...initial.combinations[0],
          id: 'official-copy',
          name: '另一配置',
          harnessRef: 'minimax-code',
          generated: false,
          isDefault: false,
        },
      ],
    }
    const { call, stored } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    const official = () =>
      walk(view).find((node) => node.getAttribute?.('data-opl-panel') === 'official-combinations')!
    const rows = () =>
      walk(official()).filter((node) => node.getAttribute?.('data-opl-combination'))
    expect(rows()).toHaveLength(2)
    await press(walk(rows()[0]).find((node) => node.getAttribute?.('role') === 'switch')!)
    expect(stored().combinations[0]).toMatchObject({
      isDefault: false,
      generated: false,
      modelRef: ref,
    })
    expect(rows()).toHaveLength(2)
    expect(text(walk(rows()[0]).find((node) => node.nodeName === 'SUMMARY')!)).toContain('非默认')
    const input = walk(rows()[0]).find((node) => node.nodeName === 'INPUT')!
    await act(async () => {
      input.value = '重命名配置'
      input.dispatchEvent('focusout')
    })
    expect(stored().combinations[0].name).toBe('重命名配置')
    expect(rows()).toHaveLength(2)
    expect(
      walk(view).find(
        (node) => node.getAttribute?.('data-opl-panel') === 'custom-combination-list',
      ),
    ).toBeUndefined()
  })

  it('组合明确不可用时标红不可用并在悬停保留原因', async () => {
    const initial = fixture(catalog())
    const call = (async (method: string, args?: unknown) =>
      method === 'combinations'
        ? [{ id: 'codex/one', available: false, reason: 'CLI 尚未安装' }]
        : initial.call(method as never, args as never)) as unknown as ExecutionCall
    const view = await open(call, ExecutionCatalogSection)
    const row = walk(view).find(
      (node) => node.getAttribute?.('data-opl-combination') === 'codex/one',
    )!
    const summary = walk(row).find((node) => node.nodeName === 'SUMMARY')!
    expect(text(summary)).toContain('不可用')
    expect(walk(summary).some((node) => node.getAttribute?.('title') === 'CLI 尚未安装')).toBe(true)
    expect(text(summary)).not.toContain('可执行')
  })

  it.each([
    ['catalog-missing', '目录已移除'],
    ['disabled', '未启用'],
    ['unconfirmed', '状态未确认'],
    [undefined, '不可用'],
  ] as const)('新模型发现与已启用组合共享状态 %s 和悬停原因', async (unavailableKind, label) => {
    const data = catalog()
    const reason = '来源返回的具体原因'
    Object.assign(data.models[0], { available: false, reason, unavailableKind })
    Object.assign(data, {
      ofmDiscovery: [
        {
          modelRef: data.models[0].ref,
          name: 'OFM 模型',
          available: false,
          reason,
          unavailableKind,
          status: { kind: 'recommended', harness: 'codex', label: '推荐 Codex CLI' },
        },
      ],
    })
    const { call } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    const discovery = walk(view).find(
      (node) => node.getAttribute?.('data-opl-panel') === 'ofm-discovery',
    )!
    const row = walk(view).find(
      (node) => node.getAttribute?.('data-opl-combination') === 'codex/one',
    )!
    const summary = walk(row).find((node) => node.nodeName === 'SUMMARY')!
    for (const scope of [discovery, summary]) {
      const badge = walk(scope).find((node) => node.getAttribute?.('title') === reason)!
      expect(text(badge)).toBe(label)
      expect(badge.getAttribute('class')).toContain('failure')
      expect(text(scope)).not.toContain('当前不可用')
      expect(text(scope)).not.toContain('未就绪')
    }
    expect(text(discovery)).toContain('推荐 Codex CLI')
    const picker = walk(view).find(
      (node) => node.getAttribute?.('data-opl-panel') === 'recommended-combinations',
    )!
    expect(
      walk(picker).filter((node) => node.getAttribute?.('data-opl-recommendation-item')),
    ).toHaveLength(0)
  })

  it('重新读取恢复可用的目录后移除两处旧状态和移除入口', async () => {
    const data = catalog()
    const discovery = {
      modelRef: data.models[0].ref,
      name: 'OFM 模型',
      available: false,
      unavailableKind: 'unconfirmed',
      reason: '来源状态未确认',
      status: { kind: 'recommended', harness: 'codex', label: '推荐 Codex CLI' },
    }
    Object.assign(data.models[0], discovery)
    Object.assign(data, { ofmDiscovery: [discovery] })
    const unavailable = await open(fixture(data).call, ExecutionCatalogSection)
    expect(text(unavailable)).toContain('状态未确认')
    Object.assign(data.models[0], { available: true })
    discovery.available = true
    const recovered = await open(fixture(data).call, ExecutionCatalogSection)
    expect(text(recovered)).not.toContain('状态未确认')
    expect(text(recovered)).not.toContain('当前不可用')
    expect(
      walk(recovered).some((node) => node.getAttribute?.('aria-label') === '移除 Codex 组合'),
    ).toBe(false)
  })

  it('普通保存保留未操作的隐藏组合和目录移除状态', async () => {
    const data = catalog()
    const ref = { provider: 'our-free-model', model: 'moonshotai/kimi-k3' }
    data.models.push({
      ref,
      name: 'EAC Kimi K3',
      source: 'our-free-model',
      available: false,
      reason: 'OFM 当前目录已移除此模型，保留原组合配置',
      unavailableKind: 'catalog-missing',
    })
    data.combinations.push({
      ...data.combinations[0],
      id: 'missing-kimi',
      name: 'EAC Kimi K3 + Kimi Code',
      modelRef: ref,
      harnessRef: 'kimi-code',
    })
    const { call, stored } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    const row = walk(view).find(
      (node) => node.getAttribute?.('data-opl-combination') === 'missing-kimi',
    )!
    const summary = walk(row).find((node) => node.nodeName === 'SUMMARY')!
    expect(text(summary)).toContain('目录已移除')
    expect(text(summary)).toContain('Our Free Model')
    expect(text(summary)).not.toContain('our-free-model')
    const picker = walk(view).find(
      (node) => node.getAttribute?.('data-opl-panel') === 'recommended-combinations',
    )!
    expect(text(picker)).not.toContain('EAC Kimi K3')
    await act(async () => {
      const input = walk(picker).find((node) =>
        node.getAttribute?.('data-opl-recommendation-item')?.includes('codex/one'),
      )!
      input.checked = false
      input.click()
    })
    await press(
      walk(picker).find((node) => node.nodeName === 'BUTTON' && text(node).includes('保存选择'))!,
    )
    expect(stored().combinations.find((item) => item.id === 'missing-kimi')?.enabled).toBe(true)
    expect(stored().combinations.find((item) => item.id === 'codex/one')?.enabled).toBe(false)
  })

  function unavailableCatalog() {
    const data = catalog()
    for (const [id, harnessRef, provider] of [
      ['missing-codex', 'codex', 'our-free-model'],
      ['missing-kimi', 'kimi-code', 'our-free-model'],
      ['removed-provider', 'zcode', 'huawei-maas'],
    ]) {
      const modelRef = { provider, model: id }
      data.models.push({ ref: modelRef, name: id, source: provider, available: false })
      data.combinations.push({
        ...data.combinations[0],
        id,
        name: id,
        modelRef,
        harnessRef,
        generated: true,
        autoEnabled: true,
      })
    }
    return data
  }

  const saveSelection = (view: Node) =>
    press(
      walk(view).find((node) => node.nodeName === 'BUTTON' && text(node).startsWith('保存选择'))!,
    )
  const clearSelection = (view: Node) =>
    press(walk(view).find((node) => node.nodeName === 'BUTTON' && text(node) === '取消全选')!)

  it('取消全选也停用隐藏的目录移除和旧供应商组合，保存后重开仍不显示', async () => {
    const data = unavailableCatalog()
    const { call, stored } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    await clearSelection(view)
    expect(stored().combinations.some((item) => item.enabled)).toBe(true)
    await saveSelection(view)
    expect(stored().combinations.every((item) => !item.enabled)).toBe(true)
    for (const item of stored().combinations.filter((item) => item.id !== 'inactive/one')) {
      expect(item).toMatchObject({
        generated: false,
        autoEnabled: false,
        autoEnabledDisabled: true,
      })
      expect(item.permissionPolicy).toBe('full-access')
    }
    expect(stored().combinations).toHaveLength(data.combinations.length)
    const reopened = await open(call, ExecutionCatalogSection)
    expect(
      walk(reopened).filter((node) => node.getAttribute?.('data-opl-combination')),
    ).toHaveLength(0)
  })

  it('取消全选后重新勾选可用项，不会重新启用隐藏项', async () => {
    const { call, stored } = fixture(unavailableCatalog())
    const view = await open(call, ExecutionCatalogSection)
    await clearSelection(view)
    await act(async () => {
      const input = walk(view).find((node) =>
        node.getAttribute?.('data-opl-recommendation-item')?.includes('codex/one'),
      )!
      input.checked = true
      input.click()
    })
    await saveSelection(view)
    expect(
      stored()
        .combinations.filter((item) => item.enabled)
        .map((item) => item.id),
    ).toEqual(['codex/one'])
  })

  it('取消 Harness 组同时停用本组的隐藏项，其他组保持启用', async () => {
    const { call, stored } = fixture(unavailableCatalog())
    const view = await open(call, ExecutionCatalogSection)
    await act(async () => {
      const input = walk(view).find(
        (node) => node.getAttribute?.('data-opl-recommendation-group') === 'codex',
      )!
      input.checked = false
      input.click()
    })
    await saveSelection(view)
    expect(
      stored()
        .combinations.filter((item) => item.harnessRef === 'codex')
        .every((item) => !item.enabled),
    ).toBe(true)
    expect(stored().combinations.find((item) => item.id === 'missing-kimi')?.enabled).toBe(true)
    expect(stored().combinations.find((item) => item.id === 'removed-provider')?.enabled).toBe(true)
  })

  it('只有不可用模型时普通保存不改配置，明确取消全选仍可停用全部', async () => {
    const data = unavailableCatalog()
    data.models = data.models.map((item) => ({ ...item, available: false }))
    const { call, calls, stored } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    expect(
      walk(view).filter((node) => node.getAttribute?.('data-opl-recommendation-item')),
    ).toHaveLength(0)
    await saveSelection(view)
    expect(calls.some((item) => item.method === 'save-catalog')).toBe(false)
    await clearSelection(view)
    await saveSelection(view)
    expect(stored().combinations.every((item) => !item.enabled)).toBe(true)
  })

  it('不可用组合可逐项移除，保留配置且不改变其他项', async () => {
    const data = unavailableCatalog()
    const { call, stored } = fixture(data)
    const view = await open(call, ExecutionCatalogSection)
    expect(walk(view).some((node) => node.getAttribute?.('aria-label') === '移除 Codex 组合')).toBe(
      false,
    )
    await press(
      walk(view).find((node) => node.getAttribute?.('aria-label') === '移除 missing-kimi')!,
    )
    const removed = stored().combinations.find((item) => item.id === 'missing-kimi')
    expect(removed).toMatchObject({
      enabled: false,
      generated: false,
      autoEnabled: false,
      autoEnabledDisabled: true,
    })
    expect(
      walk(view).some((node) => node.getAttribute?.('data-opl-combination') === 'missing-kimi'),
    ).toBe(false)
    expect(stored().combinations.filter((item) => item.id !== 'missing-kimi')).toEqual(
      data.combinations.filter((item) => item.id !== 'missing-kimi'),
    )
    const reopened = await open(call, ExecutionCatalogSection)
    expect(
      walk(reopened).some((node) => node.getAttribute?.('data-opl-combination') === 'missing-kimi'),
    ).toBe(false)
  })

  it('保存失败保留取消全选草稿，重试保存仍停用隐藏项', async () => {
    const initial = fixture(unavailableCatalog())
    let rejected = false
    const call = (async (method: string, args?: unknown) => {
      if (method === 'save-catalog' && !rejected) {
        rejected = true
        throw new Error('保存失败')
      }
      return initial.call(method as never, args as never)
    }) as ExecutionCall
    const view = await open(call, ExecutionCatalogSection)
    await clearSelection(view)
    await saveSelection(view)
    expect(initial.stored().combinations.some((item) => item.enabled)).toBe(true)
    expect(text(view)).toContain('保存失败')
    await saveSelection(view)
    expect(initial.stored().combinations.every((item) => !item.enabled)).toBe(true)
  })

  it('为每个外部 Harness 提供三种方式，内置 DSH 不可设置并说明原因', async () => {
    const { call } = fixture(catalog())
    const view = await open(call)

    for (const id of ['codex', 'claude', 'grok-build', 'minimax-code', 'custom-cli']) {
      const radios = modeRadios(row(view, id))
      expect(
        radios.map((radio) => radio.value),
        `${id} 未提供三种代理方式`,
      ).toEqual(['inherit', 'direct', 'custom'])
      expect(text(control(view, 'data-opl-harness-row', id))).toContain(
        id === 'codex'
          ? 'Codex CLI'
          : id === 'claude'
            ? 'Claude Code'
            : id === 'grok-build'
              ? 'Grok Build'
              : id === 'minimax-code'
                ? 'MiniMax Code'
                : '自建 CLI',
      )
      // Every external row can be saved on its own.
      expect(saveButton(row(view, id), id).getAttribute('aria-label')).toContain('保存')
      // Nothing is chosen for the user, and no address is asked for yet.
      expect(radios.filter((radio) => radio.checked)).toHaveLength(1)
      expect(radios.find((radio) => radio.checked)!.value).toBe('inherit')
      expect(
        walk(row(view, id)).filter((n) => n.getAttribute?.('data-opl-proxy-url')),
      ).toHaveLength(0)
    }

    // The built-in DSH Harness is in-process and says so rather than silently vanishing.
    const dsh = row(view, 'dsh')
    expect(text(dsh)).toContain('DSH')
    expect(text(dsh)).toContain('内置 DSH 与桌面同进程运行')
    expect(text(dsh)).toContain('不经过这个子进程代理选项')
    for (const radio of modeRadios(dsh))
      expect(radio.getAttribute('disabled'), 'DSH 的代理方式应不可选').not.toBeNull()
    expect(walk(dsh).filter((n) => n.getAttribute?.('data-opl-proxy-save'))).toHaveLength(0)
  })

  it('只保存被编辑的那一个 Harness，其它 Harness、模型与运行配置一字不动', async () => {
    const { call, saves, saved, harnessOf } = fixture(catalog())
    const view = await open(call)
    const before = await readCatalog(call)

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await press(saveButton(row(view, 'codex'), 'codex'))

    expect(saves()).toHaveLength(1)
    expect(saves()[0]!.args).toEqual({
      harnessId: 'codex',
      proxy: { mode: 'custom', url: 'http://127.0.0.1:7897' },
    })
    const sent = saved().catalog
    expect(harnessOf(sent, 'codex').proxy).toEqual({ mode: 'custom', url: 'http://127.0.0.1:7897' })
    // Every other Harness keeps exactly what it had, command included.
    expect(sent.harnesses.filter((harness: Harness) => harness.id !== 'codex')).toEqual(
      before.harnesses.filter((harness: Harness) => harness.id !== 'codex'),
    )
    expect(sent.models).toEqual(before.models)
    expect(sent.combinations).toEqual(before.combinations)
    // And the row says what actually happened to running work.
    expect(text(control(view, 'data-opl-proxy-outcome', 'codex'))).toContain('已保存')
    expect(text(control(view, 'data-opl-proxy-outcome', 'codex'))).toContain('后续轮次重连')
  })

  it('切换到直连与继承环境各自独立保存', async () => {
    const { call, saved, harnessOf } = fixture(catalog())
    const view = await open(call)

    await chooseMode(row(view, 'grok-build'), '直连')
    await press(saveButton(row(view, 'grok-build'), 'grok-build'))
    expect(harnessOf(saved().catalog, 'grok-build').proxy).toEqual({ mode: 'direct' })

    await chooseMode(row(view, 'claude'), '指定代理')
    await typeAddress(row(view, 'claude'), 'claude', 'https://proxy.example.test:8443')
    await press(saveButton(row(view, 'claude'), 'claude'))
    expect(harnessOf(saved().catalog, 'claude').proxy).toEqual({
      mode: 'custom',
      url: 'https://proxy.example.test:8443',
    })

    // Back to inheriting the desktop environment, which is what "no proxy" means.
    await chooseMode(row(view, 'grok-build'), '继承环境')
    await press(saveButton(row(view, 'grok-build'), 'grok-build'))
    expect(harnessOf(saved().catalog, 'grok-build').proxy).toEqual({ mode: 'inherit' })
    // Claude's saved address is untouched by Grok Build's later change.
    expect(harnessOf(saved().catalog, 'claude').proxy).toEqual({
      mode: 'custom',
      url: 'https://proxy.example.test:8443',
    })
  })

  it('重新打开运行配置时回显已保存的设置', async () => {
    const { call } = fixture(catalog({ codex: { mode: 'custom', url: 'http://127.0.0.1:7897' } }))
    const view = await open(call)

    const codex = row(view, 'codex')
    expect(modeRadios(codex).find((radio) => radio.checked)!.value).toBe('custom')
    expect(addressOf(codex, 'codex')).toBe('http://127.0.0.1:7897')
    // The built-in row has no address box at all, because it cannot be set.
    expect(
      walk(row(view, 'dsh')).filter((node) => node.getAttribute?.('data-opl-proxy-url')),
    ).toHaveLength(0)
    // A stored 直连 comes back as 直连, not as the first option.
    const direct = await open(fixture(catalog({ claude: { mode: 'direct' } })).call)
    expect(modeRadios(row(direct, 'claude')).find((radio) => radio.checked)!.value).toBe('direct')
  })

  it('只接受无用户名密码的 http/https 地址，拒绝时不写入也不回显地址', async () => {
    const { call, saves } = fixture(catalog())
    const view = await open(call)

    for (const [address, expected] of [
      ['', '请填写代理地址'],
      ['not a url at all', '格式无效'],
      ['ftp://proxy.example.test:2121', '仅支持 http'],
      ['http://user:secret@proxy.example.test:7897', '不能包含用户名或密码'],
    ] as const) {
      await chooseMode(row(view, 'codex'), '指定代理')
      await typeAddress(row(view, 'codex'), 'codex', address)
      await press(saveButton(row(view, 'codex'), 'codex'))
      const shown = text(control(row(view, 'codex'), 'data-opl-proxy-error', 'codex'))
      expect(shown, `地址 ${address || '(空)'} 应被拒绝`).toContain(expected)
      if (address) expect(shown, '拒绝提示不应回显地址').not.toContain(address)
      expect(shown).not.toContain('secret')
      expect(text(row(view, 'codex')), '被拒绝的行不应显示已保存').not.toContain('已保存')
      expect(saves(), '被拒绝的地址不应写入').toHaveLength(0)
    }
  })

  it('保存失败时不谎称成功，并保留已填内容以便重试', async () => {
    let attempt = 0
    const { call, saves } = fixture(catalog(), () => {
      attempt++
      if (attempt === 1) return new Error('无法写入运行配置')
      return undefined
    })
    const view = await open(call)

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await press(saveButton(row(view, 'codex'), 'codex'))

    expect(saves()).toHaveLength(1)
    let shown = text(control(view, 'data-opl-proxy-outcome', 'codex'))
    expect(shown).toContain('保存失败')
    expect(shown).toContain('无法写入运行配置')
    expect(shown).not.toContain('已保存')
    // The typed address survives the failure, so retrying costs nothing.
    expect(addressOf(row(view, 'codex'), 'codex')).toBe('http://127.0.0.1:7897')

    await press(saveButton(row(view, 'codex'), 'codex'))
    expect(saves()).toHaveLength(2)
    shown = text(control(view, 'data-opl-proxy-outcome', 'codex'))
    expect(shown).toContain('已保存')
  })

  it('不把含凭据的地址写进错误提示', async () => {
    const { call } = fixture(
      catalog(),
      () => new Error('保存失败：无法连接 http://user:hunter2@10.0.0.1:7897'),
    )
    const view = await open(call)

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await press(saveButton(row(view, 'codex'), 'codex'))

    const shown = text(view)
    expect(shown).toContain('保存失败')
    expect(shown, '错误提示不应带出用户名密码').not.toContain('hunter2')
    expect(shown).not.toContain('user:hunter2')
  })

  it('快速连按两次保存时只写入一次，另一行如实告知未保存', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { call, saves, harnessOf } = fixture(catalog(), () => gate)
    const view = await open(call)

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await chooseMode(row(view, 'claude'), '直连')

    // Both clicks land in the same batch, which is the window a user can hit.
    await act(async () => {
      saveButton(row(view, 'codex'), 'codex').click()
      saveButton(row(view, 'claude'), 'claude').click()
    })
    expect(saves(), '第二次保存不应另起一次写入').toHaveLength(1)
    expect(text(control(view, 'data-opl-proxy-outcome', 'claude'))).not.toContain('已保存')

    await act(async () => {
      release()
      await gate
    })

    // Only Codex was written; Claude's choice is still waiting for its own save.
    const sent = await readCatalog(call)
    expect(harnessOf(sent, 'codex').proxy).toEqual({ mode: 'custom', url: 'http://127.0.0.1:7897' })
    expect(harnessOf(sent, 'claude').proxy).toBeUndefined()
    expect(text(control(view, 'data-opl-proxy-outcome', 'codex'))).toContain('已保存')

    // The row that lost the race keeps its draft and can still be saved.
    await press(saveButton(row(view, 'claude'), 'claude'))
    expect(harnessOf(await readCatalog(call), 'claude').proxy).toEqual({
      mode: 'direct',
    })
  })

  it('保存一项时不影响另一项尚未保存的草稿', async () => {
    const { call } = fixture(catalog())
    const view = await open(call)

    await chooseMode(row(view, 'claude'), '指定代理')
    await typeAddress(row(view, 'claude'), 'claude', 'http://127.0.0.1:1080')
    await chooseMode(row(view, 'codex'), '直连')
    await press(saveButton(row(view, 'codex'), 'codex'))

    // The Claude draft was never saved and must survive Codex's save untouched.
    expect(modeRadios(row(view, 'claude')).find((radio) => radio.checked)!.value).toBe('custom')
    expect(addressOf(row(view, 'claude'), 'claude')).toBe('http://127.0.0.1:1080')
    expect(text(control(view, 'data-opl-proxy-outcome', 'codex'))).toContain('已保存')
  })

  it('放弃修改后回到已保存的值，且不触发写入', async () => {
    const { call, saves } = fixture(catalog({ codex: { mode: 'direct' } }))
    const view = await open(call)
    const before = saves().length

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await press(control(row(view, 'codex'), 'data-opl-proxy-reset', 'codex'))

    expect(saves()).toHaveLength(before)
    expect(modeRadios(row(view, 'codex')).find((radio) => radio.checked)!.value).toBe('direct')
  })
})
