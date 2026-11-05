import { createInterface } from 'node:readline'
import { writeFile, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
let sessionId = 'test-native',
  running,
  completeOnCancel = false
let effort = 'high'
const efforts =
  process.env.OPL_FIXTURE_MODEL === 'glm-5.2' ? ['high', 'max'] : ['low', 'medium', 'high', 'xhigh']
const configOptions = () => [
  {
    id: 'reasoning_effort',
    type: 'select',
    name: 'Reasoning Effort',
    currentValue: effort,
    options: efforts.map((value) => ({ value, name: value })),
  },
]
const approvals = new Map()
const editHistory = []
const editHistoryFile = () =>
  join(
    process.cwd(),
    process.env.OPL_FIXTURE_FRESH_EDIT === '1' ? `edit-${sessionId}.json` : 'edit-history.json',
  )
const persistEditHistory = async () => {
  if (process.env.OPL_FIXTURE_EDIT_PERSIST === '1')
    await writeFile(editHistoryFile(), JSON.stringify(editHistory))
}
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\n')
const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } })
const chunk = (t) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
const answer = (id, r) => send({ id, result: r })
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line)
  if (m.method?.startsWith('_x.ai/rewind/')) {
    if (process.env.OPL_FIXTURE_EDIT !== '1')
      return send({ id: m.id, error: { code: -32601, message: 'unsupported fixture' } })
    if (m.method === '_x.ai/rewind/points')
      return answer(m.id, {
        rewind_points: editHistory.map((text, prompt_index) => ({
          prompt_index,
          prompt_preview: text,
          has_file_changes: false,
        })),
      })
    const index = m.params.targetPromptIndex
    const text = editHistory[index]
    editHistory.splice(index)
    await persistEditHistory()
    return answer(m.id, {
      success: true,
      target_prompt_index: index,
      mode: 'conversation_only',
      prompt_text: text,
    })
  }
  if (m.method === 'initialize')
    answer(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
  else if (m.method === 'session/new' || m.method === 'session/load') {
    await appendFile(join(process.cwd(), 'connections.txt'), m.method + '\n')
    sessionId =
      m.params.sessionId ??
      (process.env.OPL_FIXTURE_FRESH_EDIT === '1' ? randomUUID() : 'test-native')
    if (process.env.OPL_FIXTURE_FRESH_EDIT === '1' && m.method === 'session/new')
      editHistory.length = 0
    if (process.env.OPL_FIXTURE_EDIT_PERSIST === '1') {
      try {
        const saved = JSON.parse(await readFile(editHistoryFile(), 'utf8'))
        editHistory.splice(0, editHistory.length, ...saved)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    await writeFile(
      join(process.cwd(), 'launch.json'),
      JSON.stringify({
        envKey: !!process.env.OPL_GATEWAY_GROK_API_KEY,
        hasCodex: !!process.env.OPL_GATEWAY_CODEX_API_KEY,
        home: process.env.GROK_HOME,
        args: process.argv.slice(2),
      }),
    )
    answer(m.id, {
      sessionId,
      models: { currentModelId: process.env.OPL_FIXTURE_MODEL ?? 'grok-4.7' },
      configOptions: configOptions(),
    })
  } else if (m.method === 'session/set_config_option') {
    if (m.params.configId !== 'reasoning_effort' || !efforts.includes(m.params.value))
      return send({ id: m.id, error: { code: -32602, message: 'Unsupported effort' } })
    effort = m.params.value
    answer(m.id, { configOptions: configOptions() })
  } else if (m.method === 'session/prompt') {
    running = m.id
    await appendFile(join(process.cwd(), 'calls.txt'), m.params.prompt[0].text + '\n')
    const text = m.params.prompt[0].text
    if (
      (['quota', 'quota-recorded'].includes(process.env.OPL_FIXTURE_EDIT_FAILURE) &&
        text === 'user: replacement') ||
      (process.env.OPL_FIXTURE_EDIT_FAILURE === 'ui-quota' && text.includes('EDIT_UI_RATE_LIMIT'))
    ) {
      if (process.env.OPL_FIXTURE_EDIT_FAILURE === 'quota-recorded') {
        editHistory.push(text)
        await persistEditHistory()
      }
      running = undefined
      return send({ id: m.id, error: { code: 'HARNESS_PROVIDER_RATE_LIMIT' } })
    }
    if (process.env.OPL_FIXTURE_EDIT === '1') editHistory.push(text)
    await persistEditHistory()
    if (text.startsWith('以下是先前会话记录'))
      update({
        sessionUpdate: 'session_info_update',
        title: text.replace(/s+/g, ' ').slice(0, 200),
      })
    if (text === 'tool-in-progress-wait') {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'quiet-tool',
        title: 'Long running tool',
        kind: 'execute',
        status: 'in_progress',
      })
      return
    }
    if (text === 'partial-then-wait') {
      chunk('partial answer')
      return
    }
    if (text === 'wait' || text === 'wait-end-on-cancel') {
      completeOnCancel = text === 'wait-end-on-cancel'
      if (completeOnCancel) chunk('partial answer')
      return
    }
    // A turn the agent reports as failed: the executor records `failed`, so a
    // notification about a failure can be observed without a real CLI failure.
    if (text === 'fail-turn') {
      answer(m.id, { stopReason: 'error' })
      running = undefined
      return
    }
    // A CLI that reports end_turn without delivering an answer.
    if (text === 'empty-turn') {
      update({ sessionUpdate: 'available_commands_update', availableCommands: [] })
      update({ sessionUpdate: 'usage_update', usage: { totalTokens: 0 } })
      answer(m.id, {
        stopReason: 'end_turn',
        usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      })
      running = undefined
      return
    }
    if (text.endsWith('usage-stats')) {
      chunk('usage answer')
      update({ sessionUpdate: 'usage_update', used: 42, size: 100 })
      answer(m.id, {
        stopReason: 'end_turn',
        usage: {
          totalTokens: 42,
          inputTokens: 40,
          outputTokens: 2,
          _meta: { 'opl/usageSemantics': 'per-prompt' },
        },
      })
      running = undefined
      return
    }
    if (text.endsWith('owned-usage')) {
      chunk('owned usage answer')
      answer(m.id, {
        stopReason: 'end_turn',
        _meta: {
          'opl/turnUsage': {
            version: 1,
            usage: {
              inputTokens: 30,
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              outputTokens: 4,
              reasoningTokens: 2,
              totalTokens: 49,
            },
          },
          'opl/contextUsage': { used: 49, size: 100, estimated: true },
        },
      })
      running = undefined
      return
    }
    if (text.endsWith('usage-cumulative')) {
      chunk('cumulative answer')
      update({ sessionUpdate: 'usage_update', used: 84, size: 100 })
      answer(m.id, {
        stopReason: 'end_turn',
        // ACP v1 does not identify whether these fields are per-prompt or cumulative.
        usage: { totalTokens: 84, inputTokens: 80, outputTokens: 4 },
      })
      running = undefined
      return
    }
    if (
      [
        'thought-only',
        'blank-answer',
        'tool-only-completed',
        'tool-only-failed',
        'tool-only-pending',
      ].includes(text)
    ) {
      if (text === 'thought-only')
        update({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking' },
        })
      else if (text === 'blank-answer') chunk('   \n')
      else
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'one',
          title: 'read',
          kind: 'read',
          status: text.slice('tool-only-'.length),
        })
      answer(m.id, { stopReason: 'end_turn' })
      running = undefined
      return
    }
    if (text === 'allow-write' || text === 'deny-write') {
      approvals.set('permission-string', m.id)
      send({
        id: 'permission-string',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            title: 'Write controlled.txt',
            rawInput: { command: 'printf approved > controlled.txt' },
          },
          options: [
            { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
            { optionId: 'no', kind: 'reject_once', name: 'Deny' },
          ],
        },
      })
    } else {
      const saved = await readFile(join(process.cwd(), 'memory.txt'), 'utf8').catch(() => '')
      chunk(text === 'recall' ? saved : 'result:' + text)
      if (text !== 'recall') await writeFile(join(process.cwd(), 'memory.txt'), text)
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'read1',
        title: 'Read file',
        kind: 'read',
        status: 'completed',
      })
      answer(m.id, { stopReason: 'end_turn' })
      running = undefined
    }
  } else if (m.method === 'session/cancel') {
    if (running) answer(running, { stopReason: completeOnCancel ? 'end_turn' : 'cancelled' })
    running = undefined
  } else if (m.id === 'permission-string') {
    const id = approvals.get(m.id)
    if (m.result.outcome.optionId === 'yes') {
      await writeFile(join(process.cwd(), 'controlled.txt'), 'approved')
      chunk('written')
    } else chunk('denied')
    answer(id, { stopReason: 'end_turn' })
    running = undefined
  }
})
