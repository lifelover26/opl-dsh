/** DSH Agent-scoped collaboration tools, sharing the execution owner. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HarnessService } from '../../execution/host/harness.ts'
export function installCollaborationTools(ctx: Context, harness: HarnessService): void {
  // Tools belong to each official Agent scope. Host startup must not wait on
  // an agent-scoped tool registry that does not exist until a conversation opens.
  const json = async (value: Promise<unknown>) => JSON.parse(JSON.stringify(await value))
  const install = (agent: import('@deepseek-ai/dsh-agent').Agent) =>
    agent.ctx.inject(['tools'], (scope) => {
      const origin = { kind: 'dsh' as const, sessionId: agent.id }
      const output = {
        schema: { type: 'json' as const },
        render: (_args: unknown, value: unknown) => [
          { type: 'text' as const, text: JSON.stringify(value) },
        ],
      }
      scope.tools.register(
        defineTool({
          name: 'list_harness_combinations',
          description:
            '读取跨 Harness 持久任务的运行配置及精确 ID。DSH 内部协作使用官方智能体团队或 subagent 工具。',
          parameters: {},
          output,
          execute: async () => {
            const [catalog, combinations] = await Promise.all([
              harness.executionCatalog(),
              harness.combinations(),
            ])
            const native = new Set(
              catalog.harnesses.filter((item) => item.kind === 'dsh').map((item) => item.id),
            )
            const external = new Set(
              catalog.combinations
                .filter((item) => item.harnessRef !== 'dsh' && !native.has(item.harnessRef))
                .map((item) => item.id),
            )
            return combinations.filter((item) => external.has(item.id))
          },
        }),
      )
      scope.tools.register(
        defineTool({
          name: 'delegate_to_harness',
          description:
            '在同项目创建或继续跨 Harness 的持久任务，并跟踪交付验收；DSH 内部协作使用官方智能体团队或 subagent 工具。Claude Opus 5.5 未指定渠道时默认使用 Kiro；需要 AWS 时传入精确组合 ID。默认等待结果；返回后核验实际产物并调用 review_harness_task。继续修改沿用 sessionId 和 taskId，新指令用新 operationId。已有 OPL 的 DSH 子任务可传 sessionId 继续。权限等待时请用户处理，不要重派。',
          parameters: {
            combination: {
              type: 'string',
              description:
                '可选。Claude Opus 5.5 不指定渠道时默认 Kiro；指定 AWS 时传入精确组合 ID。',
            },
            model: {
              type: 'string',
              description: '可选模型别名；填写 claude-opus-5-5 且未指定 combination 时使用 Kiro。',
            },
            task: { type: 'string', required: true },
            taskId: { type: 'string', required: true },
            operationId: { type: 'string', required: true },
            sessionId: { type: 'string' },
            acceptance: { type: 'string' },
            wait: { type: 'boolean' },
            writeScope: {
              type: 'array',
              items: { type: 'string' },
              description:
                '本轮独占写入的精确文件或目录。不相交范围可并行；省略则独占项目。范围只用于调度，不是沙箱，构建与安装使用项目根目录。',
            },
          },
          output,
          execute: async (args, exec) => {
            if (!args.sessionId && args.combination) {
              const catalog = await harness.executionCatalog()
              const target = catalog.combinations.find(
                (item) => item.id === args.combination?.trim(),
              )
              const definition = catalog.harnesses.find((item) => item.id === target?.harnessRef)
              if (target?.harnessRef === 'dsh' || definition?.kind === 'dsh') {
                const official = ['spawn_teammate', 'subagent'].filter((name) =>
                  scope.tools.executable(name, agent, exec.toolSet),
                )
                const next = official.length
                  ? `请直接使用当前可用的官方工具：${official.join('、')}。`
                  : '当前对话没有可执行的官方内部委派工具，请启用官方智能体团队或 subagent 插件。'
                throw Error(
                  `DSH 内部子任务由官方功能负责；delegate_to_harness 只创建跨 Harness 的持久任务。${next}已有 OPL 子任务可传 sessionId 继续。`,
                )
              }
            }
            return json(harness.delegateFrom(origin, args, exec.signal))
          },
        }),
      )
      scope.tools.register(
        defineTool({
          name: 'harness_result',
          description: '读取或等待当前对话委派的任务；执行完成与验收通过独立。',
          parameters: {
            sessionId: { type: 'string', required: true },
            operationId: { type: 'string' },
            wait: { type: 'boolean' },
          },
          output,
          execute: (args, exec) => json(harness.resultFor(origin, args, exec.signal)),
        }),
      )
      scope.tools.register(
        defineTool({
          name: 'list_harness_tasks',
          description: '列出当前对话委派的子任务及交付、验收状态。',
          parameters: {},
          output,
          execute: () => json(harness.tasksFor(origin)),
        }),
      )
      scope.tools.register(
        defineTool({
          name: 'report_harness_task',
          description: '子任务提交交付摘要、产物路径、实际检查和遗留问题。不代替父对话验收。',
          parameters: {
            summary: { type: 'string', required: true },
            artifacts: { type: 'array', items: { type: 'string' } },
            checks: { type: 'array', items: { type: 'string' } },
            remaining: { type: 'array', items: { type: 'string' } },
          },
          output,
          execute: (args) => harness.submitReport(origin, args),
        }),
      )
      scope.tools.register(
        defineTool({
          name: 'review_harness_task',
          description:
            'sessionId 使用返回的 harness- 开头的 ID，不用原生 acpSessionId 或 taskId。父对话核验实际产物后登记 accepted 或 changes_requested 和具体依据。要求修改后继续同一个子对话。',
          parameters: {
            sessionId: { type: 'string', required: true },
            operationId: { type: 'string', required: true },
            decision: { type: 'string', required: true },
            note: { type: 'string', required: true },
          },
          output,
          execute: (args) => json(harness.reviewTask(origin, args)),
        }),
      )
      scope.tools.register(
        defineTool({
          name: 'cancel_harness_task',
          description: '取消当前对话委派的子任务及其后代。',
          parameters: { sessionId: { type: 'string', required: true } },
          output,
          execute: (args) => json(harness.cancelTask(origin, args.sessionId)),
        }),
      )
    })
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
  })
  for (const agent of ctx.agents.list()) install(agent)
}
