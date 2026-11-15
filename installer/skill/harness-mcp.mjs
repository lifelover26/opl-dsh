/** MCP stdio adapter with a per-parent capability, never the general Host token. */
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
const binding = process.env.OPL_HARNESS_BINDING_FILE
  ? JSON.parse(await readFile(process.env.OPL_HARNESS_BINDING_FILE, 'utf8'))
  : {}
const endpoint = binding.endpoint ?? process.env.OPL_HARNESS_ENDPOINT,
  token = binding.token ?? process.env.OPL_HARNESS_TOKEN
if (!endpoint || !token) throw Error('Missing OPL Harness capability')
const call = async (method, input) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ namespace: 'harness', method, args: input, timeoutMs: 600000 }),
    signal: AbortSignal.timeout(605000),
  })
  const result = await response.json()
  if (!result.ok) throw Error(result.error)
  return result.value
}
const str = { type: 'string' },
  bool = { type: 'boolean' },
  list = { type: 'array', items: str }
const tool = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
})
const tools = [
  tool('list_harness_combinations', '读取可用运行配置及精确 ID。', {}),
  tool(
    'delegate_to_harness',
    '在同项目委派另一运行配置。Claude Opus 5.5 未指定渠道时默认使用 Kiro；需要 AWS 时传入精确组合 ID。默认等待交付，返回后核验实际产物并调用 review_harness_task。修改沿用 sessionId、taskId，新指令用新 operationId。权限等待时请用户处理，不要重派。',
    {
      combination: str,
      model: str,
      task: str,
      taskId: str,
      operationId: str,
      sessionId: str,
      acceptance: str,
      wait: bool,
    },
    ['task', 'taskId', 'operationId'],
  ),
  tool(
    'harness_result',
    '读取或等待当前对话的子任务交付。sessionId 使用返回的 harness- 开头的任务 ID，不用 acpSessionId 或 taskId。',
    { sessionId: str, operationId: str, wait: bool },
    ['sessionId'],
  ),
  tool('list_harness_tasks', '列出当前对话委派的任务及验收状态。', {}),
  tool(
    'report_harness_task',
    '提交本子任务的交付摘要、产物、实际检查和遗留问题。',
    { summary: str, artifacts: list, checks: list, remaining: list },
    ['summary'],
  ),
  tool(
    'review_harness_task',
    'sessionId 必须使用 delegate 返回的 harness- 开头的 ID（不是 acpSessionId 或 taskId）。核验实际交付后记录 accepted 或 changes_requested 及依据；需要修改则继续同一个子对话。',
    {
      sessionId: str,
      operationId: str,
      decision: { enum: ['accepted', 'changes_requested'] },
      note: str,
    },
    ['sessionId', 'operationId', 'decision', 'note'],
  ),
  tool('cancel_harness_task', '取消当前对话委派的任务及后代。', { sessionId: str }, ['sessionId']),
]
const methods = {
  list_harness_combinations: 'list',
  delegate_to_harness: 'delegate',
  harness_result: 'result',
  list_harness_tasks: 'tasks',
  report_harness_task: 'report',
  review_harness_task: 'review',
  cancel_harness_task: 'cancel',
}
async function handle(m) {
  if (m.id === undefined) return
  let result
  try {
    if (m.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'opl-harness-cooperation', version: '1.0.0' },
      }
    else if (m.method === 'ping') result = {}
    else if (m.method === 'tools/list') {
      const catalog = await call('official-tools', {})
      result = {
        tools: [
          ...(catalog.enabled ? tools : []),
          ...catalog.tools.map((tool) => ({ ...tool, name: 'dsh_' + tool.name })),
        ],
      }
    } else if (m.method === 'tools/call') {
      const a = m.params?.arguments ?? {}
      let value
      try {
        const method = methods[m.params?.name]
        if (!method && m.params?.name?.startsWith('dsh_')) {
          result = await call('official-call', { name: m.params.name.slice(4), arguments: a })
        } else if (!method) {
          throw Error('Unknown collaboration tool')
        } else {
          value = await call(method, a)
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
        }
      } catch (e) {
        result = {
          isError: true,
          content: [
            { type: 'text', text: e instanceof Error ? e.message : 'Harness request failed' },
          ],
        }
      }
    } else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32601, message: 'Method not found' },
        }) + '\n',
      )
      return
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n')
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: m.id,
        error: { code: -32603, message: 'MCP request failed' },
      }) + '\n',
    )
  }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    void handle(JSON.parse(line))
  } catch {}
})
