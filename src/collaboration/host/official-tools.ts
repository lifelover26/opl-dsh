/** Execute official collaboration tools as the exact member owning an external session. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  PERSONA_PREFIX_SECTION,
  PERSONA_SUFFIX_SECTION,
  renderPrompt,
  renderContextSnapshot,
} from '@deepseek-ai/dsh-system-prompt'
import type { OfficialCollaborationPort } from '../../execution/contracts/official-collaboration.ts'

const names = new Set([
  'subagent',
  'subagent_fork',
  'list_agents',
  'send_message',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'skill',
  'list_subagent_models',
])

export class OfficialCollaborationBridge implements OfficialCollaborationPort {
  private readonly lifetime = new AbortController()
  constructor(private readonly ctx: Context) {
    ctx.effect(() => () => this.lifetime.abort())
  }

  private agent(sessionId: string): Agent {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    if (!agent) throw Error('官方成员会话未加载，协作工具不可用')
    return agent
  }

  async instructions(sessionId: string, signal: AbortSignal): Promise<string> {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    const agent = this.agent(sessionId)
    const selection = agent.model.current()
    if (!selection) throw Error('官方成员尚未选择模型')
    const toolSet = await agent.ctx.tools.resolve({ agent, modelSelection: selection, signal })
    let assembly
    try {
      assembly = await agent.ctx.systemPrompt.assemble({
        scope: agent,
        agent,
        modelSelection: selection,
        toolSet,
        signal,
      })
    } finally {
      toolSet.dispose()
    }
    const persona = renderPrompt({
      ...assembly,
      sections: assembly.sections.filter((section) =>
        [PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, 'team:policy'].includes(section.name),
      ),
    })
    return [
      persona,
      renderContextSnapshot(assembly),
      'For official DSH team membership, messages and tasks, use the opl-harness MCP tools named dsh_*. Discover official member names with dsh_list_agents; send team messages with dsh_send_message. These tools act as your current official DSH member.',
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  async tools(sessionId: string, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    const agent = this.agent(sessionId)
    const selection = agent.model.current()
    if (!selection) throw Error('官方成员尚未选择模型')
    const admitted = await agent.ctx.tools.resolve({ agent, modelSelection: selection, signal })
    try {
      return [...admitted.view(agent).values()]
        .filter((tool) => names.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>,
        }))
    } finally {
      admitted.dispose()
    }
  }

  async call(sessionId: string, name: string, args: unknown, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    if (!names.has(name)) throw Error('此工具不属于官方协作能力')
    const agent = this.agent(sessionId)
    const selection = agent.model.current()
    if (!selection) throw Error('官方成员尚未选择模型')
    const admitted = await agent.ctx.tools.resolve({ agent, modelSelection: selection, signal })
    try {
      if (!agent.ctx.tools.executable(name, agent, admitted))
        throw Error('当前官方成员没有可执行的该工具')
      const batch = await agent.ctx.tools.execute({
        agent,
        toolSet: admitted,
        signal,
        calls: [
          {
            type: 'tool-call',
            id: `opl-member-${randomUUID()}` as ToolCallId,
            name,
            arguments: JSON.stringify(args ?? {}),
          },
        ],
      })
      const result = batch.results[0]?.result
      if (!result) throw Error('官方工具没有返回执行结果')
      return {
        content: [
          ...result.content,
          ...batch.additionalContexts.flatMap((message) => message.content),
        ],
        isError: result.isError,
      }
    } finally {
      admitted.dispose()
    }
  }
}
