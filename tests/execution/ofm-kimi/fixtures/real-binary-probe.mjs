#!/usr/bin/env node
/**
 * Real-binary probe for the official Kimi Code CLI driven by the OFM route.
 *
 * Nothing here simulates the shell. A controlled loopback provider speaks the Anthropic
 * Messages streaming protocol, the real binary calls its own `Bash` tool, and that tool
 * really executes on Windows through the Git-for-Windows bash the adapter pins. The
 * evidence is the file written on disk plus the git output the tool returned.
 *
 * git usage is read-only (`git --version`, `git status --porcelain`); no repository is
 * created and nothing is committed.
 *
 * Modes:
 *   yolo / plan — run the tool turn under that permission mode.
 *   hold        — provider never answers, so the turn stays active and can be cancelled.
 *   omit        — start the CLI without the route variables (the differential).
 *
 * Teardown is awaited: the child is asked to exit and waited for, and the HTTP server is
 * closed with its connections dropped. Results are written before the process exits, on
 * success and on failure alike.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const BIN = process.argv[2]
const OUT = process.argv[3]
// Owned runtime root passed to the CLI as KIMI_CODE_HOME. It is a plain local name for a
// directory this probe owns; HOME and CODEX_HOME are never set or redirected.
const ownedProfilePath = process.argv[4]
const SHELL = process.argv[5]
const WIRE_MODEL = process.argv[6] || 'moonshotai/kimi-k3'
const MODE = process.argv[7] || 'yolo'
const BEHAVIOUR = process.argv[8] || ''
if (!BIN || !OUT || !ownedProfilePath || !SHELL) {
  console.error(
    'usage: real-binary-probe.mjs <bin> <out.json> <ownedProfilePath> <bash> <wireModel> [mode] [omit|hold]',
  )
  process.exit(2)
}

const HOLD = BEHAVIOUR === 'hold'
const OMIT = BEHAVIOUR === 'omit'

// A working directory with non-ASCII characters and a space, owned by this probe.
const WORK = `${ownedProfilePath}/../中文 目录 work`
const TARGET = '说明.txt'
const PROBE_COMMAND = [
  // Where the official tool actually ran: non-ASCII, and containing a space.
  'pwd',
  `printf '来自 kimi 的写入\\n' > '${TARGET}'`,
  `cat '${TARGET}'`,
  // Real, read-only git invocations. No repository is created and nothing is committed;
  // the trailing guard keeps the chain's exit status meaningful outside a repository.
  'git --version',
  '(git status --porcelain 2>&1 || true)',
].join(' && ')

const wire = []
let requestClosed = false
let markRequestSeen = () => {}
/** Resolves once the CLI has actually placed a model request, i.e. the turn is live. */
const requestSeen = new Promise((r) => {
  markRequestSeen = r
})

/** Flatten an ACP tool_result's content into readable text. */
function flattenToolResult(block) {
  if (block === undefined) return null
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part)))
      .join('\n')
      .slice(0, 800)
  return JSON.stringify(content).slice(0, 800)
}

const sse = (res, blocks, stopReason) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_probe',
      type: 'message',
      role: 'assistant',
      model: WIRE_MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      })
    } else {
      send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      })
    }
    send('content_block_stop', { type: 'content_block_stop', index })
  })
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  })
  send('message_stop', { type: 'message_stop' })
  res.end()
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  // Record that the client went away mid-request, which is how an active-turn cancel
  // reaches the provider.
  req.on('aborted', () => {
    requestClosed = true
  })
  res.on('close', () => {
    requestClosed = true
  })
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      body = raw
    }
    const toolResults = (body?.messages ?? [])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c) => c?.type === 'tool_result')
    wire.push({
      method: req.method,
      url: req.url,
      aborted: requestClosed,
      anthropicVersion: req.headers['anthropic-version'] ?? null,
      model: body?.model,
      stream: body?.stream,
      toolNames: (body?.tools ?? []).map((t) => t.name),
      sawToolResult: toolResults.length,
      toolResultPreview: flattenToolResult(toolResults[0]),
    })
    markRequestSeen()
    if (BEHAVIOUR === 'reject' || (BEHAVIOUR === 'recover' && wire.length === 1)) {
      res.writeHead(500, {
        'content-type': 'application/json',
        'x-should-retry': BEHAVIOUR === 'recover' ? 'true' : 'false',
        'retry-after-ms': '1',
      })
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'fixture server failure' },
        }),
      )
      return
    }
    if (HOLD) {
      // Never answer, so the turn stays active until the client cancels it.
      return
    }
    if (toolResults.length === 0)
      return sse(
        res,
        [
          {
            type: 'tool_use',
            id: 'toolu_probe_1',
            name: 'Bash',
            input: { command: PROBE_COMMAND, description: 'probe' },
          },
        ],
        'tool_use',
      )
    sse(res, [{ type: 'text', text: 'probe-done' }], 'end_turn')
  })
})

const listen = () =>
  new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))

const port = await listen()
if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
mkdirSync(ownedProfilePath, { recursive: true })

const env = {
  ...process.env,
  CI: '1',
  NO_COLOR: '1',
  // A per-run scratch directory, so an owned TEMP is still honoured.
  TEMP: `${ownedProfilePath}/tmp`,
  TMP: `${ownedProfilePath}/tmp`,
  KIMI_CODE_HOME: ownedProfilePath,
  // The shell this adapter would pin, so the official tool runs under it.
  KIMI_SHELL_PATH: SHELL,
  ...(OMIT
    ? {}
    : {
        KIMI_MODEL_NAME: WIRE_MODEL,
        KIMI_MODEL_API_KEY: 'dummy-probe-key',
        KIMI_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
        KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
      }),
}

const report = {
  probe: 'kimi-real-bash-tool',
  wireModel: WIRE_MODEL,
  providerType: OMIT ? null : 'anthropic',
  routeOmitted: OMIT,
  holdForCancel: HOLD,
  mode: MODE,
  workDir: WORK,
  targetFile: `${WORK}/${TARGET}`,
  teardown: {},
}

const child = spawn(process.execPath, [BIN, 'acp'], {
  cwd: WORK,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env,
})
let stderr = ''
child.stderr.on('data', (d) => (stderr += String(d)))
const childExited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))

const pending = new Map()
const updates = []
const updateWaiters = []
let seq = 0
const request = (method, params, timeoutMs = 90000) =>
  new Promise((res, rej) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      rej(new Error(`timeout ${method}`))
    }, timeoutMs)
    pending.set(id, { res, rej, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
createInterface({ input: child.stdout }).on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.method === 'session/update') {
    updates.push(m.params)
    for (const waiter of updateWaiters.splice(0))
      if (m.params?.update?.sessionUpdate === waiter.kind) waiter.resolve(m.params)
  } else if (typeof m.id === 'number' && m.method === undefined) {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.error) p.rej(Object.assign(new Error('rpc'), { rpc: m.error }))
    else p.res(m.result)
  }
})

const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

/**
 * Resolve on the next notification of a given kind, or reject on timeout.
 *
 * Waiters are served by the single stdout reader above; opening a second reader on the
 * same stream would split its data and swallow replies.
 */
const waitForUpdate = (kind, timeoutMs = 30000) =>
  new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`no ${kind} notification`)), timeoutMs)
    updateWaiters.push({
      kind,
      resolve: (value) => {
        clearTimeout(timer)
        res(value)
      },
    })
  })

/** Close the child and the HTTP server, waiting for both. */
async function shutdown() {
  try {
    child.stdin.end()
  } catch {}
  child.kill()
  const timer = new Promise((r) => setTimeout(() => r(null), 10000))
  report.teardown.childExit = await Promise.race([childExited, timer])
  // Drop keep-alive sockets so close() can complete, then wait for it.
  server.closeAllConnections?.()
  const closed = new Promise((r) => server.close(() => r('closed')))
  const closedTimer = new Promise((r) => setTimeout(() => r('timeout'), 10000))
  report.teardown.httpClose = await Promise.race([closed, closedTimer])
  report.teardown.clientSawRequestClose = requestClosed
}

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'real-binary-probe', version: '0.0.0' },
  })
  report.agentInfo = init.agentInfo

  let created
  try {
    created = await request('session/new', { cwd: WORK, mcpServers: [] })
  } catch (error) {
    report.sessionNewError = error?.rpc ?? String(error?.message)
  }

  if (created) {
    const sessionId = created.sessionId
    report.sessionId = sessionId
    const pick = (options, id) => options.find((o) => o.id === id)
    report.modelOption = {
      currentValue: pick(created.configOptions, 'model')?.currentValue,
      values: (pick(created.configOptions, 'model')?.options ?? []).map((o) => o.value),
    }
    report.modeOption = {
      currentValue: pick(created.configOptions, 'mode')?.currentValue,
      values: (pick(created.configOptions, 'mode')?.options ?? []).map((o) => o.value),
    }
    const afterMode = await request('session/set_config_option', {
      sessionId,
      configId: 'mode',
      value: MODE,
    })
    report.modeAfterSet = pick(afterMode.configOptions, 'mode')?.currentValue
    report.modelAfterSet = pick(afterMode.configOptions, 'model')?.currentValue

    if (HOLD) {
      // Start the turn and wait until the CLI has an in-flight model request, then cancel
      // while it is still open. Cancelling after completion would prove nothing.
      const prompt = request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'hold' }] },
        90000,
      )
      await requestSeen
      report.turnActiveBeforeCancel = true
      notify('session/cancel', { sessionId })
      report.prompt = await prompt.then(
        (r) => ({ ok: true, stopReason: r.stopReason }),
        (e) => ({ ok: false, error: e.rpc ?? String(e.message) }),
      )
      report.providerRequestAborted = requestClosed
      report.toolWroteFile = existsSync(`${WORK}/${TARGET}`)
    } else {
      report.prompt = await request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'run the probe command' }] },
        90000,
      ).then(
        (r) => ({ ok: true, stopReason: r.stopReason }),
        (e) => ({ ok: false, error: e.rpc ?? String(e.message) }),
      )
      const target = `${WORK}/${TARGET}`
      report.toolWroteFile = existsSync(target)
      report.fileContent = report.toolWroteFile ? readFileSync(target, 'utf8').trim() : null
      // Cancel is accepted on a settled session, and must not disturb it.
      notify('session/cancel', { sessionId })
      await new Promise((r) => setTimeout(r, 300))
      report.loaded = await request('session/load', { sessionId, cwd: WORK, mcpServers: [] }).then(
        (r) => ({
          ok: true,
          model: pick(r.configOptions, 'model')?.currentValue,
          mode: pick(r.configOptions, 'mode')?.currentValue,
        }),
        (e) => ({ ok: false, error: e.rpc ?? String(e.message) }),
      )
      report.closed = await request('session/close', { sessionId }).then(
        () => ({ ok: true }),
        (e) => ({ ok: false, error: e.rpc ?? String(e.message) }),
      )
    }
  }
} catch (error) {
  report.fatal = String(error?.message ?? error)
  report.rpcError = error?.rpc
} finally {
  report.updates = updates.map((u) => u?.update?.sessionUpdate ?? null)
  report.stderrTail = stderr.slice(0, 800)
  report.wire = wire
  await shutdown()
  // Written after teardown so the record includes it, and written even on failure.
  writeFileSync(OUT, JSON.stringify(report, null, 2))
}
process.exit(0)
