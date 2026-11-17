import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'

const call = vi.fn()
vi.mock('../../src/computer-use/host/kimi-cu.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/computer-use/host/kimi-cu.ts')>()
  return {
    ...actual,
    KimiCuClient: class {
      start = vi.fn()
      close = vi.fn()
      call = call
    },
  }
})

import { installComputerUse } from '../../src/computer-use/host/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  call.mockReset()
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

class ToolRegistry extends Service {
  readonly tools = new Map<
    string,
    { execute: (args: unknown, exec: unknown) => Promise<unknown> }
  >()
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  register(definition: {
    name: string
    execute: (args: unknown, exec: unknown) => Promise<unknown>
  }) {
    this.tools.set(definition.name, definition)
    return () => this.tools.delete(definition.name)
  }
}

class Agents extends Service {
  readonly list = () => [agent]
  constructor(ctx: Context) {
    super(ctx, 'agents')
  }
  on() {
    return () => {}
  }
}

const agent = {
  id: 'session-1',
  session: { id: 'session-1' },
  ctx: {
    inject: vi.fn((_deps: string[], callback: (scope: Context) => void) => {
      callback({
        tools,
        attachments: { saveImages: async () => [] },
      } as unknown as Context)
    }),
    get: (name: string) => (name === 'tools' ? tools : undefined),
  },
}
let tools: ToolRegistry

async function fixture(preset: string, platform: NodeJS.Platform = 'darwin') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin({
    apply(provider: Context) {
      tools = new ToolRegistry(provider)
      new Agents(provider)
      provider.provide('permissionPresets', {
        current: () => preset,
      })
      provider.provide('attachments', {
        saveImages: async () => [],
      })
    },
  })
  installComputerUse(ctx, { platform })
  return tools.tools.get('computer_use')!
}

describe('Computer Use DSH tool', () => {
  it('does not expose a macOS or Windows companion on Linux', async () => {
    expect(await fixture('read-only', 'linux')).toBeUndefined()
  })

  it('allows read-only observation without changing the session permission', async () => {
    call.mockResolvedValue({ content: [{ type: 'text', text: 'Finder' }] })
    const tool = await fixture('read-only')
    await expect(
      tool.execute(
        { action: 'list_apps', args: { running_only: true } },
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ text: 'Finder', images: [] })
    expect(call).toHaveBeenCalledWith('list_apps', { running_only: true }, expect.any(AbortSignal))
    expect(agent.ctx.inject).toHaveBeenCalledWith(['tools', 'attachments'], expect.any(Function))
  })

  it('refuses a desktop mutation until the session explicitly selects Full access', async () => {
    const tool = await fixture('workspace-write')
    await expect(
      tool.execute(
        { action: 'click', args: { index: 1 } },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('完全访问')
    expect(call).not.toHaveBeenCalled()
  })

  it('permits the same mutation under the explicit Full access preset', async () => {
    call.mockResolvedValue({ content: [{ type: 'text', text: 'clicked' }] })
    const tool = await fixture('danger-full-access')
    await expect(
      tool.execute(
        { action: 'click', args: { index: 1 } },
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ text: 'clicked' })
  })
})
