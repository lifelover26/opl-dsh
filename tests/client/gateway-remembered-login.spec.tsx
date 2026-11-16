import { createTestDom } from './dom.ts'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { zh } from '../../src/gateway/client/locales.ts'
import type { GatewayRememberedLogin } from '../../src/gateway/contracts/account.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', props, children),
}))
const { OplGatewaySection } = await import('../../src/gateway/client/OplGatewaySection.tsx')
const roots: Root[] = []
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()))
})
type Node = { nodeName: string; childNodes: Node[]; getAttribute: (name: string) => string | null }
function walk(node: Node): Node[] {
  return [node, ...(node.childNodes ?? []).flatMap(walk)]
}
// React owns these event props; the lightweight DOM does not implement input bubbling.
function props(node: Node): Record<string, any> {
  const key = Object.keys(node).find((key) => key.startsWith('__reactProps$'))!
  return (node as unknown as Record<string, Record<string, any>>)[key]!
}
async function mount(
  saved: GatewayRememberedLogin | Promise<GatewayRememberedLogin> = { supported: true },
) {
  const dom = createTestDom(),
    container = dom.container(),
    root = createRoot(container as unknown as HTMLElement)
  roots.push(root)
  const status = {
    phase: 'signed-out' as const,
    endpoint: 'https://fixture.invalid',
    keyReady: false,
  }
  const actions = {
    status: vi.fn(async () => status),
    refresh: vi.fn(async () => status),
    signOut: vi.fn(async () => status),
    signIn: vi.fn(async () => ({ status, createdKey: false })),
    signInRemembered: vi.fn(async () => ({ status, createdKey: false })),
    rememberedLogin: vi.fn(async () => saved),
    forgetPassword: vi.fn(async () => {}),
  }
  await act(async () =>
    root.render(
      <OplGatewaySection
        {...actions}
        t={((key: keyof typeof zh) => zh[key]) as never}
        onboarding
      />,
    ),
  )
  const nodes = () => walk(container as unknown as Node)
  const input = (type: string) =>
    nodes().find((n) => n.nodeName === 'INPUT' && props(n).type === type)!
  const submit = async () => {
    await act(async () =>
      props(nodes().find((n) => n.nodeName === 'FORM')!).onSubmit({ preventDefault() {} }),
    )
  }
  return { actions, input, submit, nodes }
}
it('requires explicit opt-in and submits the typed password once', async () => {
  const v = await mount()
  expect(props(v.input('checkbox')).checked).toBe(false)
  await act(async () =>
    props(v.input('email')).onChange({ target: { value: 'person@example.test' } }),
  )
  await act(async () =>
    props(v.input('password')).onChange({ target: { value: 'fixture-secret' } }),
  )
  await act(async () => props(v.input('checkbox')).onChange({ target: { checked: true } }))
  await v.submit()
  expect(v.actions.signIn).toHaveBeenCalledExactlyOnceWith(
    'person@example.test',
    'fixture-secret',
    true,
  )
  expect(props(v.input('password')).value).toBe('')
})
it('uses saved login without rendering its password and rejects a different email', async () => {
  const v = await mount({ supported: true, email: 'person@example.test' })
  expect(props(v.input('password')).value).toBe('')
  expect(props(v.input('password')).required).toBe(false)
  expect(v.actions.signInRemembered).not.toHaveBeenCalled()
  await v.submit()
  expect(v.actions.signInRemembered).toHaveBeenCalledExactlyOnceWith('person@example.test')
  await act(async () =>
    props(v.input('email')).onChange({ target: { value: 'other@example.test' } }),
  )
  expect(props(v.input('password')).required).toBe(true)
  expect(
    props(v.nodes().find((n) => n.nodeName === 'BUTTON' && props(n).type === 'submit')!).disabled,
  ).toBe(true)
})
it('unchecking clears the stored credential and requires password input again', async () => {
  const v = await mount({ supported: true, email: 'person@example.test' })
  await act(async () => props(v.input('checkbox')).onChange({ target: { checked: false } }))
  expect(v.actions.forgetPassword).toHaveBeenCalledOnce()
  expect(props(v.input('checkbox')).checked).toBe(false)
  expect(props(v.input('password')).required).toBe(true)
})

it('shows a disabled remember control while keyring state is pending', async () => {
  let finish!: (value: GatewayRememberedLogin) => void
  const pending = new Promise<GatewayRememberedLogin>((resolve) => {
    finish = resolve
  })
  const view = await mount(pending)
  expect(view.input('checkbox')).toBeDefined()
  expect(props(view.input('checkbox')).disabled).toBe(true)
  await act(async () => finish({ supported: true }))
  expect(props(view.input('checkbox')).disabled).toBe(false)
})

it('keeps group activation switches non-wrapping and deduplicates shared proxy hints in account diagnostics', async () => {
  const { readFileSync } = await import('node:fs')
  const cssSource = readFileSync(
    new URL('../../src/shared/client/SettingsSection.module.css', import.meta.url),
    'utf8',
  )
  expect(cssSource).toMatch(/\.switchControl\s*\{[^}]*white-space:\s*nowrap/s)
  expect(cssSource).toMatch(/\.switchControl\s*\{[^}]*flex-shrink:\s*0/s)
  expect(cssSource).toMatch(/\.modelRow\s*>\s*:first-child\s*\{[^}]*min-width:\s*0/s)

  const networkMessage =
    '无法连接目录服务，请检查网络和推理地址。原生 DSH 的代理可在其主目录 .env 中配置 HTTPS_PROXY/HTTP_PROXY，修改后需重启；执行引擎代理仅影响 CLI 子进程。'
  const dom = createTestDom()
  const container = dom.container()
  const root = createRoot(container as unknown as HTMLElement)
  roots.push(root)
  const status = {
    phase: 'connected' as const,
    source: 'session' as const,
    endpoint: 'https://gateway.medopl.com/v1',
    keyReady: true,
    account: {
      displayName: 'Test',
      email: 'person@example.test',
      status: 'active',
      balanceAmount: 10,
      balanceCurrency: 'USD',
      todayTokens: 1,
      totalTokens: 2,
      todayCost: 0.1,
      totalCost: 0.2,
      usageCurrency: 'USD',
      keyName: 'key',
    },
    groups: [
      {
        id: 'deepseek' as const,
        name: 'DeepSeek',
        enabled: true,
        authorized: true,
        rateMultiplier: 1,
        state: 'ready' as const,
        catalog: {
          state: 'error' as const,
          diagnostic: { code: 'network' as const, message: networkMessage },
        },
      },
      {
        id: 'kiro' as const,
        name: 'Kiro',
        enabled: true,
        authorized: true,
        rateMultiplier: 1,
        state: 'ready' as const,
        catalog: {
          state: 'error' as const,
          diagnostic: { code: 'network' as const, message: networkMessage },
        },
      },
    ],
  }
  await act(async () =>
    root.render(
      <OplGatewaySection
        status={vi.fn(async () => status)}
        refresh={vi.fn(async () => status)}
        signOut={vi.fn(async () => status)}
        signIn={vi.fn(async () => ({ status, createdKey: false }))}
        setGroupActive={vi.fn(async () => status)}
        t={((key: keyof typeof zh) => zh[key]) as never}
      />,
    ),
  )
  const switches = walk(container as unknown as Node).filter(
    (n) => n.nodeName === 'INPUT' && props(n).role === 'switch',
  )
  expect(switches).toHaveLength(2)
  for (const toggle of switches) {
    const label = (toggle as unknown as { parentNode: Node }).parentNode
    const className = label.getAttribute('class') ?? String(props(label).className ?? '')
    expect(className).toContain('switchControl')
  }
  const text = (container as unknown as { textContent: string }).textContent
  expect(text).toContain('无法连接目录服务，请检查网络和推理地址。')
  expect(text.split('HTTPS_PROXY/HTTP_PROXY')).toHaveLength(2)
})
