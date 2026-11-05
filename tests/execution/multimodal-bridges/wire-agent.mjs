import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const mode = process.env.OPL_MULTIMODAL_FIXTURE_MODE
const sessionId = 'multimodal-wire-session'
const historyContent = process.env.OPL_MULTIMODAL_HISTORY
  ? JSON.parse(process.env.OPL_MULTIMODAL_HISTORY)
  : undefined
let turns = historyContent
  ? [
      {
        id: 'imported-turn',
        status: 'completed',
        items: [{ type: 'userMessage', content: historyContent }],
      },
    ]
  : []
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(process.env.OPL_MULTIMODAL_WIRE_LOG, JSON.stringify(message) + '\n')
  if (mode === 'acp') {
    if (message.method === 'initialize')
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: process.env.OPL_MULTIMODAL_ACP_IMAGE === '1' },
          },
          agentInfo: { name: 'wire-fixture', version: '1.0.0' },
        },
      })
    else send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (mode === 'codex') {
    if (message.method === 'initialize')
      send({ id: message.id, result: { userAgent: 'multimodal-wire-fixture' } })
    if (message.method === 'thread/start' || message.method === 'thread/resume')
      send({ id: message.id, result: { thread: { id: sessionId }, model: message.params.model } })
    if (message.method === 'turn/start') {
      const turnId = `wire-turn-${turns.length + 1}`
      turns.push({
        id: turnId,
        status: 'completed',
        items: [{ type: 'userMessage', content: message.params.input }],
      })
      send({ id: message.id, result: { turn: { id: turnId } } })
      send({
        method: 'item/agentMessage/delta',
        params: { threadId: sessionId, turnId, itemId: 'wire-answer', delta: 'ok' },
      })
      send({
        method: 'turn/completed',
        params: { threadId: sessionId, turn: { id: turnId, status: 'completed' } },
      })
    }
    if (message.method === 'thread/turns/list')
      send({ id: message.id, result: { data: turns, nextCursor: null } })
    if (message.method === 'thread/revert') {
      turns = turns.slice(
        0,
        turns.findIndex((turn) => turn.id === message.params.beforeTurnId),
      )
      send({ id: message.id, result: {} })
    }
    return
  }
  if (message.type === 'control_request') {
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response:
          message.request.subtype === 'get_context_usage'
            ? { totalTokens: 2, rawMaxTokens: 200000 }
            : { commands: [], models: [], account: {} },
      },
    })
  }
  if (message.type === 'user') {
    const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'multimodal-fixture')
    mkdirSync(project, { recursive: true })
    appendFileSync(
      join(project, message.session_id + '.jsonl'),
      JSON.stringify({
        type: 'user',
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: message.session_id,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        message: historyContent ? { role: 'user', content: historyContent } : message.message,
      }) + '\n',
    )
    send({
      type: 'system',
      subtype: 'init',
      session_id: message.session_id,
      permissionMode: 'bypassPermissions',
    })
    send({
      type: 'assistant',
      uuid: randomUUID(),
      session_id: message.session_id,
      parent_tool_use_id: null,
      message: {
        id: 'wire-answer',
        type: 'message',
        role: 'assistant',
        model: process.env.OPL_NATIVE_MODEL,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    })
    send({
      type: 'result',
      subtype: 'success',
      uuid: randomUUID(),
      session_id: message.session_id,
      is_error: false,
      result: 'ok',
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
})
