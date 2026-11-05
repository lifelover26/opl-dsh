/** No-key Step RPC fixture for native edit semantics confirmed against StepCode 0.1.4. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const agent = process.env.STEP_CODING_AGENT_DIR
const sessions = process.env.STEP_CODING_AGENT_SESSION_DIR
const config = JSON.parse(readFileSync(join(dirname(agent), 'models.json'), 'utf8'))
const [provider, providerConfig] = Object.entries(config.providers)[0]
const modelConfig = providerConfig.models[0]
const modelView = {
  ...modelConfig,
  provider,
  api: providerConfig.api,
  baseUrl: providerConfig.baseUrl,
}
const controlsPath = join(agent, 'edit-controls.json')
const controls = () =>
  existsSync(controlsPath) ? JSON.parse(readFileSync(controlsPath, 'utf8')) : {}
const write = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const logs = join(agent, 'edit-rpc-commands.jsonl')
const clone = (value) => structuredClone(value)
let id = randomUUID(),
  file = join(sessions, `${id}.jsonl`),
  entries = []
let model = null,
  thinking = 'medium',
  forked = false
let streaming = false
let activePrompt

mkdirSync(sessions, { recursive: true })
const persist = () =>
  writeFileSync(
    file,
    [
      { type: 'session', version: 3, id, cwd: process.cwd(), timestamp: new Date().toISOString() },
      ...entries,
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  )
const hasUser = () =>
  entries.some((entry) => entry.type === 'message' && entry.message.role === 'user')
const append = (fields) => {
  entries.push({
    id: randomUUID(),
    parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    ...fields,
  })
  if (existsSync(file)) persist()
}
const branch = () => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const path = []
  for (let cursor = entries.at(-1)?.id; cursor; cursor = byId.get(cursor)?.parentId)
    path.push(byId.get(cursor))
  return path.reverse()
}
const restore = () => {
  const path = branch()
  const storedModel = [...path].reverse().find((entry) => entry.type === 'model_change')
  model =
    storedModel?.modelId === modelView.id && storedModel?.provider === provider ? modelView : null
  thinking =
    [...path].reverse().find((entry) => entry.type === 'thinking_level_change')?.thinkingLevel ??
    'medium'
}

async function forkGate() {
  const gate = join(agent, 'edit-fork-release')
  const opened = join(agent, 'edit-fork-started')
  await new Promise((resolve) => {
    const watcher = watch(agent, () => {
      if (existsSync(gate)) {
        watcher.close()
        resolve()
      }
    })
    writeFileSync(opened, 'ready')
    if (existsSync(gate)) {
      watcher.close()
      resolve()
    }
  })
}

async function handle(message) {
  appendFileSync(logs, JSON.stringify(message) + '\n')
  const knobs = controls()
  const respond = (data, success = true) =>
    write({
      id: message.id,
      type: 'response',
      command: message.type,
      success,
      ...(data === undefined ? {} : { data }),
    })
  switch (message.type) {
    case 'get_state':
      respond({
        sessionId: id,
        sessionFile: file,
        model: forked && knobs.forkModelDrift ? { ...modelView, id: 'wrong-live-model' } : model,
        thinkingLevel: thinking,
        isStreaming: streaming || knobs.streaming === true,
        isCompacting: knobs.compacting === true,
        pendingMessageCount: knobs.pending ? 1 : 0,
        messageCount: branch().filter((entry) => entry.type === 'message').length,
      })
      return
    case 'get_session_stats':
      respond({
        sessionId: id,
        sessionFile: file,
        totalMessages: entries.length,
        tokens: { input: 0, output: 0 },
      })
      return
    case 'get_available_thinking_levels':
      respond({
        levels:
          knobs.noThinkingAfterFork && forked
            ? ['off']
            : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      })
      return
    case 'get_available_models':
      respond({ models: [modelView] })
      return
    case 'set_model':
      if (model?.id !== modelView.id || model?.provider !== provider) {
        model = modelView
        append({ type: 'model_change', provider, modelId: model.id })
      }
      respond(model)
      return
    case 'set_thinking_level':
      if (!(forked && knobs.noThinkingEcho) && thinking !== message.level) {
        thinking = message.level
        append({ type: 'thinking_level_change', thinkingLevel: thinking })
      }
      respond()
      return
    case 'switch_session':
      if (existsSync(message.sessionPath)) {
        const rows = readFileSync(message.sessionPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        id = rows[0].id
        file = message.sessionPath
        entries = rows.slice(1)
        forked = false
        restore()
      }
      respond({ cancelled: false })
      return
    case 'get_messages':
      respond({
        messages: branch()
          .filter((entry) => entry.type === 'message')
          .map((entry) => entry.message),
      })
      return
    case 'get_entries': {
      if (knobs.unsupported) {
        respond(undefined, false)
        return
      }
      const values = clone(entries)
      if (knobs.changedTool) {
        const tool = values.find(
          (entry) => entry.type === 'message' && entry.message.role === 'toolResult',
        )
        if (tool) tool.message.content = [{ type: 'text', text: 'CHANGED TOOL RESULT' }]
      }
      if (knobs.duplicateId && values.length) values.push(clone(values[0]))
      if (knobs.orphan && values.length) values.at(-1).parentId = 'missing-entry'
      if (knobs.cycle && values.length) values.at(-1).parentId = values.at(-1).id
      respond({ entries: values, leafId: values.at(-1)?.id ?? null })
      return
    }
    case 'fork': {
      if (knobs.holdFork) await forkGate()
      if (knobs.forkReject) {
        respond(undefined, false)
        return
      }
      if (knobs.forkCancel) {
        respond({ text: 'cancelled', cancelled: true })
        return
      }
      const path = branch()
      const target = path.findIndex(
        (entry) => entry.id === message.entryId && entry.message?.role === 'user',
      )
      if (target < 0) {
        respond(undefined, false)
        return
      }
      const text = path[target].message.content
      entries = clone(path.slice(0, target + (knobs.keepTarget ? 1 : 0)))
      id = randomUUID()
      file = join(sessions, `${id}.jsonl`)
      forked = true
      restore()
      if (!hasUser()) {
        model = modelView
        thinking = 'medium'
        append({ type: 'model_change', provider, modelId: model.id })
        append({ type: 'thinking_level_change', thinkingLevel: thinking })
      } else {
        if (knobs.corruptTool) {
          const tool = entries.find((entry) => entry.message?.role === 'toolResult')
          if (tool) tool.message.content = [{ type: 'text', text: 'CORRUPT RETAINED TOOL' }]
        }
        if (knobs.corruptCompaction) {
          const compaction = entries.find((entry) => entry.type === 'compaction')
          if (compaction) compaction.summary = 'CORRUPT RETAINED COMPACTION'
        }
        persist()
      }
      if (knobs.forkExit) {
        process.exit(0)
        return
      }
      if (knobs.rejectAfterMutation) {
        respond(undefined, false)
        return
      }
      respond({ text, cancelled: false })
      return
    }
    case 'prompt': {
      const nativeMessage = {
        role: 'user',
        content: [{ type: 'text', text: message.message }],
        timestamp: Date.now(),
      }
      if (knobs.changedPrefix) {
        const prior = entries.find((entry) => entry.message?.role === 'user')
        if (prior) prior.message.content = 'changed retained input'
      }
      append({
        type: 'message',
        message: nativeMessage,
        ...(knobs.inputWrongParent ? { parentId: entries[0]?.id ?? null } : {}),
      })
      if (knobs.duplicateNewInput) append({ type: 'message', message: clone(nativeMessage) })
      respond(undefined, knobs.rejectPrompt !== true)
      write({ type: 'agent_start' })
      const eventMessage = clone(nativeMessage)
      if (knobs.inputTimestampMismatch) eventMessage.timestamp++
      if (knobs.inputTimestampMissing) delete eventMessage.timestamp
      if (knobs.inputContentMismatch) eventMessage.content[0].text = 'different event input'
      write({ type: 'message_start', message: eventMessage })
      write({ type: 'message_end', message: eventMessage })
      if (knobs.holdPrompt) {
        streaming = true
        activePrompt = nativeMessage
        writeFileSync(join(agent, 'edit-prompt-started'), 'ready')
        return
      }
      append({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'fixture response' }],
          provider,
          model: model?.id,
          api: providerConfig.api,
          timestamp: Date.now(),
          stopReason: 'stop',
        },
      })
      persist()
      write({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'fixture response' },
      })
      write({ type: 'message_end', message: entries.at(-1).message })
      write({ type: 'agent_end', messages: [entries.at(-1).message] })
      write({ type: 'agent_settled' })
      return
    }
    case 'abort':
      respond()
      if (activePrompt && !knobs.holdAbort) {
        streaming = false
        activePrompt = undefined
        append({
          type: 'message',
          message: {
            role: 'assistant',
            content: [],
            provider,
            model: model?.id,
            api: providerConfig.api,
            timestamp: Date.now(),
            stopReason: 'aborted',
          },
        })
        persist()
        write({ type: 'message_end', message: entries.at(-1).message })
        write({ type: 'agent_end', messages: [entries.at(-1).message] })
        write({ type: 'agent_settled' })
      }
      return
    default:
      respond(undefined, false)
  }
}

let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8')
  for (;;) {
    const newline = input.indexOf('\n')
    if (newline < 0) break
    const line = input.slice(0, newline).replace(/\r$/, '')
    input = input.slice(newline + 1)
    if (line.trim()) void handle(JSON.parse(line))
  }
})
