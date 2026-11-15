import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { OfficialCollaborationBridge } from '../../src/collaboration/host/official-tools.ts'

function fixture() {
  let dispose!: () => void
  const toolSet = {
    view: vi.fn(
      () =>
        new Map([
          [
            'send_message',
            {
              name: 'send_message',
              description: 'Official message',
              parameters: { type: 'object' },
            },
          ],
          ['bash', { name: 'bash', description: 'Native shell', parameters: { type: 'object' } }],
        ]),
    ),
    dispose: vi.fn(),
  }
  const tools = {
    resolve: vi.fn(async ({ signal }) => {
      signal.throwIfAborted()
      return toolSet
    }),
    executable: vi.fn(() => true),
    execute: vi.fn(async () => ({
      results: [
        { result: { content: [{ type: 'text', text: 'official receipt' }], isError: false } },
      ],
      additionalContexts: [],
    })),
  }
  const agent = {
    id: 'member',
    ctx: {
      tools,
      systemPrompt: {
        assemble: vi.fn(async () => ({
          sections: [
            { name: 'deployment:persona-prefix', text: 'Reviewer using {{model}}' },
            { name: 'team:policy', text: 'Official team policy' },
            { name: 'native-shell', text: 'Unrelated shell instructions' },
          ],
          variables: { model: 'resolved-model' },
          contexts: [],
          tools: [],
        })),
      },
    },
    model: { current: () => ({ provider: 'source', model: 'model' }) },
  }
  const ctx = {
    agents: { get: (id: string) => (id === 'member' ? agent : undefined) },
    effect: (effect: () => () => void) => {
      dispose = effect()
    },
  } as unknown as Context
  return {
    bridge: new OfficialCollaborationBridge(ctx),
    agent,
    tools,
    toolSet,
    dispose: () => dispose(),
  }
}

describe('official collaboration authority', () => {
  it('assembles the official persona with the actual member, selection and admitted tools', async () => {
    const { bridge, agent, toolSet } = fixture()
    const text = await bridge.instructions('member', new AbortController().signal)
    expect(agent.ctx.systemPrompt.assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        scope: agent,
        modelSelection: agent.model.current(),
        toolSet,
      }),
    )
    expect(text).toContain('Reviewer using resolved-model')
    expect(text).toContain('Official team policy')
    expect(text).not.toContain('Unrelated shell instructions')
    expect(toolSet.dispose).toHaveBeenCalledOnce()
  })
  it('advertises only admitted collaboration tools and executes as the exact member', async () => {
    const { bridge, agent, tools, toolSet } = fixture()
    const signal = new AbortController().signal
    expect((await bridge.tools('member', signal)).map((tool) => tool.name)).toEqual([
      'send_message',
    ])
    const args = { recipient: 'lead', message: 'done' }
    expect(await bridge.call('member', 'send_message', args, signal)).toEqual({
      content: [{ type: 'text', text: 'official receipt' }],
      isError: false,
    })
    expect(tools.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        toolSet,
        calls: [expect.objectContaining({ name: 'send_message', arguments: JSON.stringify(args) })],
      }),
    )
    expect(toolSet.dispose).toHaveBeenCalledTimes(2)
  })

  it('refuses another identity, native shell access, and revoked tool admission', async () => {
    const { bridge, tools, toolSet } = fixture()
    const signal = new AbortController().signal
    await expect(bridge.call('other', 'send_message', {}, signal)).rejects.toThrow('未加载')
    await expect(bridge.call('member', 'bash', {}, signal)).rejects.toThrow('不属于')
    tools.executable.mockReturnValue(false)
    await expect(bridge.call('member', 'send_message', {}, signal)).rejects.toThrow('没有可执行')
    expect(tools.execute).not.toHaveBeenCalled()
    expect(toolSet.dispose).toHaveBeenCalledOnce()
  })

  it('aborts admission after the collaboration plugin is disabled', async () => {
    const { bridge, dispose, tools } = fixture()
    dispose()
    await expect(
      bridge.call('member', 'send_message', {}, new AbortController().signal),
    ).rejects.toThrow()
    expect(tools.execute).not.toHaveBeenCalled()
  })
})
