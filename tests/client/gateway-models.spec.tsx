// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { GatewayModelSettings } from '../../src/gateway/contracts/models.ts'
import type { GatewayCall } from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', props, children),
}))
const { GatewayModels } = await import('../../src/gateway/client/GatewayModels.tsx')
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
afterAll(() => vi.unstubAllGlobals())
const roots: Root[] = []
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren()
})
type Node = { nodeName: string; textContent: string; childNodes: Node[] }
function walk(node: Node): Node[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(walk)]
}
function props(node: Node): Record<string, any> {
  const key = Object.keys(node).find((key) => key.startsWith('__reactProps$'))!
  return (node as unknown as Record<string, Record<string, any>>)[key]!
}
function snapshot(): GatewayModelSettings {
  return {
    groups: ['codex', 'aws'].map((id) => ({
      id,
      name: id === 'codex' ? 'OpenAI 协议' : 'AWS',
      api: id === 'aws' ? 'anthropic-messages' : 'openai-responses',
      models: [{ id: `${id}-configured`, metadata: { custom: [true, null] }, input: ['text'] }],
      enabled: true,
      ready: true,
      state: 'ready',
      revision: 0,
      catalog: { state: 'unverified' },
    })),
  }
}
async function mount(discover: (group: string) => Promise<unknown[]>) {
  const data = snapshot(),
    edits: unknown[] = []
  const call = vi.fn(async (method: string, request?: any) => {
    if (method === 'read') return structuredClone(data)
    if (method === 'discover') return discover(request.group)
    if (method === 'edit') {
      edits.push(request)
      const group = data.groups.find((group) => group.id === request.group)!
      group.models = request.models
      group.revision++
      return structuredClone(data)
    }
    throw Error('Unexpected method')
  })
  const container = document.createElement('div'),
    root = createRoot(container as unknown as HTMLElement)
  document.body.append(container)
  roots.push(root)
  await act(async () => root.render(<GatewayModels call={call as GatewayCall} />))
  const nodes = () => walk(container as unknown as Node)
  const click = async (text: string) => {
    await act(async () =>
      props(
        nodes().find((node) => node.nodeName === 'BUTTON' && node.textContent === text)!,
      ).onClick(),
    )
  }
  return { data, edits, call, container, nodes, click }
}

it('shows each discovery failure reason when every group fails and preserves existing candidates', async () => {
  const view = await mount(async (group) => {
    throw Error(
      group === 'aws'
        ? 'AWS：目录请求超时，请检查网络与代理后重试。'
        : 'OpenAI 协议：目录服务拒绝此渠道的凭据或权限。 (HTTP 403)',
    )
  })
  await view.click('选择模型')
  expect(view.container.textContent).toContain('AWS：目录请求超时')
  expect(view.container.textContent).toContain('HTTP 403')
  expect(
    view.nodes().filter((node) => node.nodeName === 'INPUT' && props(node).type === 'checkbox'),
  ).toHaveLength(1)
  await view.click('保存选择')
  expect(view.edits).toEqual([])
  expect(view.data).toEqual(snapshot())
})

it('keeps successful candidates and nested metadata while another group fails', async () => {
  const candidate = {
    id: 'gpt-candidate',
    input: ['text', 'image'],
    compat: { supportsDeveloperRole: false },
    custom: { nested: [true, null] },
  }
  const view = await mount(async (group) => {
    if (group === 'aws') throw Error('AWS：无法连接目录服务，请检查网络、代理和此渠道的推理地址。')
    return [candidate]
  })
  await view.click('选择模型')
  expect(view.container.textContent).toContain('AWS：无法连接目录服务')
  const options = view
    .nodes()
    .filter((node) => node.nodeName === 'INPUT' && props(node).type === 'checkbox')
  expect(options).toHaveLength(2)
  await act(async () =>
    props(options.find((node) => !props(node).checked)!).onChange({ target: { checked: true } }),
  )
  await view.click('保存选择')
  expect(view.edits).toHaveLength(1)
  expect(view.data.groups[0]!.models).toContainEqual(candidate)
  expect(view.data.groups[1]).toEqual(snapshot().groups[1])
})

it('deduplicates shared proxy guidance across failed groups, clears stale catalog diagnostics on recovery, and displays canonical Gemini names', async () => {
  const networkMessage =
    '无法连接目录服务，请检查网络和推理地址。原生 DSH 的代理可在其主目录 .env 中配置 HTTPS_PROXY/HTTP_PROXY，修改后需重启；执行引擎代理仅影响 CLI 子进程。'
  const state: GatewayModelSettings = {
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        api: 'messages',
        models: [{ id: 'deepseek-flash' }],
        enabled: true,
        ready: true,
        state: 'ready',
        revision: 0,
        catalog: { state: 'error', diagnostic: { code: 'network', message: networkMessage } },
      },
      {
        id: 'kiro',
        name: 'Kiro',
        api: 'anthropic-messages',
        models: [{ id: 'claude-opus-5-5' }],
        enabled: true,
        ready: true,
        state: 'ready',
        revision: 0,
        catalog: { state: 'unverified' },
      },
      {
        id: 'gemini',
        name: 'Gemini',
        api: 'openai-completions',
        models: [
          { id: 'gemini-4-carbon', name: 'gemini-4-carbon' },
          { id: 'gemini-4-hydrogen', name: 'gemini-4-hydrogen' },
        ],
        enabled: true,
        ready: true,
        state: 'ready',
        revision: 0,
        catalog: { state: 'ready', count: 2 },
      },
    ],
  }
  let shouldFail = true
  const call = vi.fn(async (method: string, request?: any) => {
    if (method === 'read') return structuredClone(state)
    if (method === 'discover') {
      const group = state.groups.find((item) => item.id === request.group)!
      if (shouldFail && (request.group === 'deepseek' || request.group === 'kiro')) {
        group.catalog = { state: 'error', diagnostic: { code: 'network', message: networkMessage } }
        throw Error(`${group.name}：${networkMessage}`)
      }
      group.catalog = { state: 'ready', count: group.models.length }
      return group.models
    }
    throw Error('Unexpected method')
  })
  const container = document.createElement('div')
  const root = createRoot(container as unknown as HTMLElement)
  document.body.append(container)
  roots.push(root)
  await act(async () => root.render(<GatewayModels call={call as GatewayCall} />))
  expect(container.textContent).toContain('Gemini 4 Carbon')
  expect(container.textContent).toContain('Gemini 4 Hydrogen')
  const click = async (text: string) => {
    const button = walk(container as unknown as Node).find(
      (node) => node.nodeName === 'BUTTON' && node.textContent === text,
    )!
    await act(async () => props(button).onClick())
  }
  await click('选择模型')
  const text = container.textContent ?? ''
  expect(text).toContain('DeepSeek：无法连接目录服务')
  expect(text).toContain('Kiro：无法连接目录服务')
  expect(text).not.toContain('。；')
  expect(text.split('HTTPS_PROXY/HTTP_PROXY')).toHaveLength(2)
  expect(text.split('DeepSeek：无法连接目录服务')).toHaveLength(2)

  shouldFail = false
  await click('选择模型')
  const recoveredText = container.textContent ?? ''
  expect(recoveredText).not.toContain('无法连接目录服务')
})
