import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as officialMcp from '@deepseek-ai/dsh-mcp-client'
import Resources from '@deepseek-ai/dsh-mcp-resources'
import { describe, expect, it } from 'vitest'
import * as plugin from '../../src/mcp-apps/host/index.ts'
import { inspectMcpAppHost, officialMcpBridgeVersion } from '../../src/mcp-apps/host/status.ts'

async function registry() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  return ctx
}

describe('MCP Apps no-UI handoff', () => {
  it('reports current scope and does not extrapolate an API assessment to newer versions', () => {
    const visible = new Set(['read_mcp_resource', 'owner_review'])
    const known = inspectMcpAppHost((name) => visible.has(name), 'owner_review', '0.2.2-rc.1')
    expect(known.selectedTool?.available).toBe(true)
    expect(known.resourceTools).toEqual(['read_mcp_resource'])
    expect(known.nextAction).toBe('call-owner-tool')
    visible.delete('owner_review')
    expect(
      inspectMcpAppHost((name) => visible.has(name), 'owner_review', null).selectedTool?.available,
    ).toBe(false)
    const newer = inspectMcpAppHost(() => true, undefined, '9.0.0')
    expect(newer.officialBridge).toMatchObject({
      assessment: 'unverified-version',
      missingPublicCapabilities: [],
    })
  })

  it('registers on official Agent scopes and observes owner removal without invoking it', async () => {
    const ctx = await registry()
    const scopeA = createScope(ctx)
    const scopeB = createScope(ctx)
    const agentA = { ctx: scopeA.ctx } as Agent
    const agentB = { ctx: scopeB.ctx } as Agent
    // Agent identity is the official scope key; do not derive it from a UI argument.
    const agentScopeA = createScope(ctx, agentA)
    agentA.ctx = agentScopeA.ctx
    const agentScopeB = createScope(ctx, agentB)
    agentB.ctx = agentScopeB.ctx
    ctx.provide('agents', { list: () => [agentA, agentB] })
    let calls = 0
    const owner: ToolDefinition = {
      name: 'owner_review',
      description: '',
      parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => {
        calls++
        return {}
      },
    }
    let remove!: () => void
    await agentA.ctx.inject(['tools'], (scope) => {
      remove = scope.tools.register(owner)
    })
    try {
      const mounted = ctx.plugin(plugin)
      await mounted
      const toolA = ctx.get('tools')!.get('inspect_mcp_app_host', agentA)!
      const toolB = ctx.get('tools')!.get('inspect_mcp_app_host', agentB)!
      ctx.get('tools')!.register({ ...owner, name: 'conditional_review' }, { when: () => true })
      ctx.get('tools')!.register({ ...owner, name: 'restricted_review' })
      await agentA.ctx.inject(['tools'], (scope) => {
        scope.tools.restrict({ deny: ['restricted_review'] })
      })
      const exec = { signal: new AbortController().signal } as never
      expect(await toolA.execute({ toolName: 'owner_review' }, exec)).toMatchObject({
        selectedTool: { available: true },
      })
      expect(await toolB.execute({ toolName: 'owner_review' }, exec)).toMatchObject({
        selectedTool: { available: false },
      })
      remove()
      expect(await toolA.execute({ toolName: 'owner_review' }, exec)).toMatchObject({
        selectedTool: { available: false },
      })
      expect(await toolA.execute({ toolName: 'restricted_review' }, exec)).toMatchObject({
        selectedTool: { available: false },
      })
      expect(await toolA.execute({ toolName: 'conditional_review' }, exec)).toMatchObject({
        selectedTool: { available: false },
      })
      const toolSet = await ctx.get('tools')!.resolve({
        agent: agentA,
        modelSelection: { provider: 'fixture', model: 'fixture' },
        signal: new AbortController().signal,
      })
      expect(
        await toolA.execute({ toolName: 'conditional_review' }, {
          signal: new AbortController().signal,
          toolSet,
        } as never),
      ).toMatchObject({ selectedTool: { available: true } })
      toolSet.dispose()
      expect(calls).toBe(0)
      await mounted.dispose()
      expect(ctx.get('tools')!.get('inspect_mcp_app_host', agentA)).toBeUndefined()
      expect(ctx.get('tools')!.get('inspect_mcp_app_host', agentB)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps actual official MCP owner data while identifying the current UI metadata gap', async () => {
    const ctx = await registry()
    try {
      await ctx.plugin(Resources)
      await ctx.plugin(officialMcp, {
        transport: 'stdio',
        serverName: 'fixture',
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixture-server.mjs', import.meta.url))],
        env: {},
        cwd: process.cwd(),
        toolCallTimeoutMs: 5000,
        failOnStartupError: true,
        reconnect: { enabled: false },
      })
      const tool = ctx.get('tools')!.get('mcp__fixture__review')!
      const exec = { signal: new AbortController().signal } as never
      const result = (await tool.execute({}, exec)) as Record<string, any>
      expect(result.structuredContent).toMatchObject({ object_id: 'fixture-1', revision: 3 })
      expect(officialMcpBridgeVersion()).toBe('0.2.2-rc.1')
      expect(result.structuredContent.capabilities).not.toHaveProperty('extensions')
      expect(tool).not.toHaveProperty('_meta')
      expect(result).not.toHaveProperty('_meta')
      const resource = await ctx.tools
        .get('read_mcp_resource')!
        .execute({ server: 'fixture', uri: 'ui://opl/apps.html' }, exec)
      expect(resource).toMatchObject({
        contents: [{ uri: 'ui://opl/apps.html', mimeType: 'text/html;profile=mcp-app' }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
