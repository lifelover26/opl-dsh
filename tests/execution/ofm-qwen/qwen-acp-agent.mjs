/** Qwen 0.27.3 live request deltas and load replay through the real ACP transport. */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const directory = process.argv[2]
const stateFile = join(directory, 'session.json')
const model = 'amd/Qwen3.8-27B'
const qualified = `${model}(openai)`
let state
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const reply = (id, result) => send({ id, result })
const notify = (update) =>
  send({ method: 'session/update', params: { sessionId: state.id, update } })
const usage = (inputTokens, outputTokens, cachedReadTokens, thoughtTokens) => ({
  inputTokens,
  outputTokens,
  cachedReadTokens,
  thoughtTokens,
  totalTokens: inputTokens + outputTokens,
})
const chunk = (counters, meta) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: '' },
  _meta: { usage: counters, ...meta },
})
const replay = () =>
  notify(
    chunk(usage(999000, 999, 0, 0), {
      timestamp: '2026-11-15T00:00:00Z',
      'qwen.session.recordId': 'historical-request',
      qwenTranscript: { sourceRecordIds: ['historical-request'] },
    }),
  )
const snapshot = () => ({
  models: {
    currentModelId: qualified,
    availableModels: [
      {
        modelId: qualified,
        _meta: {
          baseModelId: model,
          authType: 'openai',
          envKey: 'OPENAI_API_KEY',
          baseUrl: 'https://qwen-usage-fixture.example.test/v1',
          contextLimit: 128000,
        },
      },
    ],
  },
  modes: { currentModeId: 'yolo' },
  configOptions: [
    { id: 'model', type: 'select', currentValue: qualified },
    { id: 'mode', type: 'select', currentValue: 'yolo' },
    { id: 'reasoning_effort', type: 'select', currentValue: 'default' },
  ],
})

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const { id, method, params } = JSON.parse(line)
    appendFileSync(
      join(directory, 'journal.ndjson'),
      JSON.stringify({ method, cwd: params?.cwd }) + '\n',
    )
    if (method === 'initialize')
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: 'openai', name: 'OpenAI-compatible API' }],
        agentInfo: { name: '@qwen-code/qwen-code', version: '0.27.3' },
      })
    else if (method === 'authenticate') {
      if (params.methodId !== 'openai') throw Error('Unexpected auth route')
      reply(id, {})
    } else if (method === 'session/new' || method === 'session/load') {
      if (method === 'session/new') {
        state = { id: randomUUID(), calls: 0 }
        writeFileSync(stateFile, JSON.stringify(state))
      } else {
        state = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (params.sessionId !== state.id) throw Error('Unexpected restored session')
        replay()
      }
      reply(id, { ...snapshot(), ...(method === 'session/new' ? { sessionId: state.id } : {}) })
    } else if (method === 'session/prompt') {
      if (params.sessionId !== state.id) throw Error('Unexpected prompt session')
      state.calls += 1
      writeFileSync(stateFile, JSON.stringify(state))
      replay()
      notify(chunk(usage(500000, 999, 0, 0), { durationMs: 1, parentToolCallId: 'child' }))
      const deltas =
        state.calls === 1
          ? [usage(100, 20, 30, 5), usage(200, 40, 30, 5)]
          : [usage(300, 60, 50, 7), usage(400, 80, 60, 8)]
      for (const counters of deltas) {
        notify(chunk(counters, { durationMs: 12 }))
        notify({ sessionUpdate: 'usage_update', used: counters.inputTokens, size: 128000 })
      }
      notify({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'QWEN_RESULT' },
      })
      reply(id, { stopReason: 'end_turn' })
    } else if (id !== undefined) {
      send({ id, error: { code: -32601, message: 'Unsupported fixture method' } })
    }
  })
  .on('close', () => process.exit(0))
