/** Caller-scoped, read-only MCP Apps readiness and no-UI handoff. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { inspectMcpAppHost } from './status.ts'

export const name = 'opl-mcp-app-host-status'
export const inject = ['agents']

export function apply(ctx: Context): void {
  const install = (agent: Agent) => {
    const fork = agent.ctx.inject(['tools'], (scope) => {
      scope.tools.register(
        defineTool({
          name: 'inspect_mcp_app_host',
          description:
            'Read this OPL host’s MCP Apps presentation support and whether an exact owner tool is available to the current conversation. Does not open a connection, invoke the owner, or repeat a mutation. Use owner structured results and their explicit browser/professional-app handoff when embedded UI is unavailable.',
          parameters: {
            toolName: {
              type: 'string',
              description:
                'Optional exact tool name already discovered in this conversation. No server identity is inferred from its spelling.',
            },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) =>
            JSON.parse(
              JSON.stringify(
                inspectMcpAppHost(
                  (name) => scope.tools.executable(name, agent, exec.toolSet) !== undefined,
                  args.toolName,
                ),
              ),
            ),
        }),
      )
    })
    ctx.effect(() => () => fork.dispose())
  }
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
  })
  for (const agent of ctx.agents.list()) install(agent)
}
