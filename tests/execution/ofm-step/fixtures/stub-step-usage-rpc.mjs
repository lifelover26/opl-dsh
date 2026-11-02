/** Scripted official Step RPC frames; all configuration and history belongs to one test. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const agentDir = process.env.STEP_CODING_AGENT_DIR
const sessionDir = process.env.STEP_CODING_AGENT_SESSION_DIR
const scenario = JSON.parse(readFileSync(join(agentDir, 'usage-scenario.json'), 'utf8'))
const providers = JSON.parse(readFileSync(join(dirname(agentDir), 'models.json'), 'utf8')).providers
const sessionId = 'step-usage-session'
const sessionFile = join(sessionDir, `${sessionId}.jsonl`)
if (!existsSync(sessionFile)) writeFileSync(sessionFile, '')
let model
let plan
let promptCount = 0
let active = false
let contextUsage = scenario.initialContext ?? { tokens: 0, contextWindow: scenario.effectiveWindow }

const write = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const save = (message) => appendFileSync(sessionFile, JSON.stringify(message) + '\n')
const emit = (event) => {
  if (event.message?.role === 'assistant')
    event = { ...event, message: { provider: model.provider, model: model.id, ...event.message } }
  write(event)
  if (event.type === 'message_end') save(event.message)
}
const emitAll = (events = []) => events.forEach(emit)

function handle(command) {
  appendFileSync(join(agentDir, 'usage-rpc-commands.jsonl'), JSON.stringify(command.type) + '\n')
  const respond = (data, success = true) =>
    write({ id: command.id, type: 'response', command: command.type, success, data })
  switch (command.type) {
    case 'get_state':
      respond({ sessionId, sessionFile, model: model ?? null, isStreaming: active })
      return
    case 'set_model': {
      const entry = providers[command.provider].models.find((item) => item.id === command.modelId)
      model = {
        provider: command.provider,
        id: command.modelId,
        contextWindow: entry.contextWindow ?? scenario.effectiveWindow,
      }
      respond(model)
      return
    }
    case 'get_available_thinking_levels':
      respond({ levels: ['off'] })
      return
    case 'get_session_stats':
      if (plan?.statsFailure === 'silent') return
      if (plan?.statsFailure === 'rejected') {
        respond(undefined, false)
        return
      }
      respond({
        sessionId,
        // These totals deliberately contain unrelated historic/tool/summary work.
        tokens: { input: 999_999, output: 999_999, cacheRead: 999_999, cacheWrite: 999_999 },
        contextUsage,
      })
      return
    case 'switch_session':
      respond({ cancelled: false })
      return
    case 'get_messages':
      respond({
        messages: readFileSync(sessionFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      })
      return
    case 'prompt':
      plan = scenario.turns[promptCount++]
      if (plan?.rejected) {
        respond(undefined, false)
        return
      }
      save({ role: 'user', content: command.message })
      respond(undefined)
      active = true
      emit({ type: 'agent_start' })
      emitAll(plan?.events)
      contextUsage = plan?.contextUsage
      if (!plan?.waitForAbort) {
        active = false
        emit({ type: 'agent_settled' })
      }
      return
    case 'abort':
      respond(undefined)
      if (active) {
        emitAll(plan?.abortEvents)
        active = false
        emit({ type: 'agent_settled' })
      }
      return
    default:
      respond(undefined, false)
  }
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline).replace(/\r$/, '')
    buffer = buffer.slice(newline + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
