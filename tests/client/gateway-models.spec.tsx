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
