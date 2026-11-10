import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import type { HarnessService } from '../../src/execution/host/harness.ts'
import type { ExecutionCatalog } from '../../src/execution/contracts/catalog.ts'
import type { HarnessCatalog } from '../../src/execution/contracts/sessions.ts'
import { installCollaborationTools } from '../../src/collaboration/host/tools.ts'

function stubHarness() {
  const calls: Array<{ origin: unknown; args: unknown; signal: AbortSignal }> = []
  const harness = {
    executionCatalog: async (): Promise<ExecutionCatalog> => ({
      version: 2,
      models: [],
      harnesses: [
        { id: 'dsh-alias', name: 'Misleading external label', kind: 'dsh' },
        { id: 'codex', name: 'Codex', kind: 'acp' },
      ],
      combinations: [
        {
          id: 'native-combination',
          name: 'Native DSH',
          modelRef: { provider: 'deepseek', model: 'native' },
          harnessRef: 'dsh-alias',
          permissionPolicy: 'workspace',
          isDefault: false,
          enabled: true,
        },
        {
          id: 'external-combination',
          name: 'External Codex',
          modelRef: { provider: 'openai', model: 'codex' },
          harnessRef: 'codex',
          permissionPolicy: 'workspace',
          isDefault: true,
          enabled: true,
        },
      ],
    }),
    // Keep the real model-facing row shape: `harness` is a display label,
    // while only the execution catalog owns the stable Harness reference.
    combinations: async (): Promise<HarnessCatalog['combinations']> => [
      {
        id: 'native-combination',
        name: 'Native DSH',
        model: 'native',
        modelId: 'native',
        harness: 'Misleading external label',
        source: 'official',
        available: true,
      },
      {
        id: 'external-combination',
        name: 'External Codex',
        model: 'codex',
        modelId: 'codex',
        harness: 'Codex',
        source: 'official',
        available: true,
      },
    ],
    delegateFrom: async (origin: unknown, args: unknown, signal: AbortSignal) => {
      calls.push({ origin, args, signal })
      return { ok: true }
    },
  }
  return { harness: harness as unknown as HarnessService, calls }
}

async function setup(harness: HarnessService) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const agentScope = createScope(ctx)
  const agent = { id: 'agent-a', ctx: agentScope.ctx } as unknown as Agent
  agent.ctx = createScope(ctx, agent).ctx
  ctx.provide('agents', { list: () => [agent] })
  installCollaborationTools(ctx, harness)
  return { ctx, agent }
}

const exec = (signal = new AbortController().signal, toolSet?: unknown) =>
  ({ signal, ...(toolSet ? { toolSet } : {}) }) as never

const officialTool = (name: string): ToolDefinition => ({
  name,
  description: name,
  parameters: { type: 'object' },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({}),
})

const nativeRequest = {
  combination: 'native-combination',
  task: 'internal',
  taskId: 'task-1',
  operationId: 'op-1',
}

describe('DSH collaboration tool cutover', () => {
  it('lists only external combinations using stable harness references', async () => {
    const { harness } = stubHarness()
    const { ctx, agent } = await setup(harness)
    try {
      const tool = ctx.get('tools')!.get('list_harness_combinations', agent)!
      await expect(tool.execute({}, exec())).resolves.toEqual([
        expect.objectContaining({ id: 'external-combination' }),
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects new native delegation and reports only executable official tools', async () => {
    const { harness, calls } = stubHarness()
    const { ctx, agent } = await setup(harness)
    try {
      ctx.get('tools')!.register(officialTool('spawn_teammate'))
      ctx.get('tools')!.register(officialTool('subagent'))
      await agent.ctx.inject(['tools'], (scope) => scope.tools.restrict({ deny: ['subagent'] }))
      const tool = ctx.get('tools')!.get('delegate_to_harness', agent)!
      const error = await tool.execute(nativeRequest, exec()).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('当前可用的官方工具：spawn_teammate。')
      expect((error as Error).message).not.toContain('subagent')
      expect(calls).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses official step admission and refuses a private fallback when no tool is admitted', async () => {
    const { harness, calls } = stubHarness()
    const { ctx, agent } = await setup(harness)
    try {
      ctx.get('tools')!.register(officialTool('subagent'), { when: () => true })
      const tool = ctx.get('tools')!.get('delegate_to_harness', agent)!
      await expect(tool.execute(nativeRequest, exec())).rejects.toThrow(
        '当前对话没有可执行的官方内部委派工具',
      )
      const signal = new AbortController().signal
      const toolSet = await ctx.get('tools')!.resolve({
        agent,
        modelSelection: { provider: 'fixture', model: 'fixture' },
        signal,
      })
      try {
        await expect(tool.execute(nativeRequest, exec(signal, toolSet))).rejects.toThrow(
          '当前可用的官方工具：subagent。',
        )
      } finally {
        toolSet.dispose()
      }
      expect(calls).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves old native session continuation and forwards external dispatch', async () => {
    const { harness, calls } = stubHarness()
    const { ctx, agent } = await setup(harness)
    try {
      const tool = ctx.get('tools')!.get('delegate_to_harness', agent)!
      const signal = new AbortController().signal
      await expect(
        tool.execute(
          {
            combination: 'native-combination',
            sessionId: 'legacy-session',
            task: 'continue',
            taskId: 'task-1',
            operationId: 'op-2',
          },
          exec(signal),
        ),
      ).resolves.toEqual({ ok: true })
      await expect(
        tool.execute(
          {
            combination: 'external-combination',
            task: 'external',
            taskId: 'task-2',
            operationId: 'op-3',
          },
          exec(signal),
        ),
      ).resolves.toEqual({ ok: true })
      expect(calls).toHaveLength(2)
      expect(calls[0]?.args).toMatchObject({ sessionId: 'legacy-session' })
      expect(calls[0]?.signal).toBe(signal)
      expect(calls[1]?.origin).toEqual({ kind: 'dsh', sessionId: 'agent-a' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves canonical model alias resolution and validation with the Harness owner', async () => {
    const { harness, calls } = stubHarness()
    const { ctx, agent } = await setup(harness)
    try {
      const tool = ctx.get('tools')!.get('delegate_to_harness', agent)!
      const request = {
        model: 'claude-opus-5-5',
        task: 'external',
        taskId: 'task-2',
        operationId: 'op-3',
      }
      await expect(tool.execute(request, exec())).resolves.toEqual({ ok: true })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.args).toEqual(request)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
