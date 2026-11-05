import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const command = process.env.OPL_TEST_CLAUDE_COMMAND
const bridgeSource = resolve('src/execution/host/adapters/native-harness-bridge.ts')
const imageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='

test(
  'Claude bridge resumes a saved session and sends ordered text and image blocks to Messages',
  { skip: !command, timeout: 90000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'opl-claude-bridge-'))
    const cwd = await realpath(home)
    const requests = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      if (!body || !req.url?.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      requests.push({ path: req.url, ...JSON.parse(body) })
      const reply = (value) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      reply({
        type: 'message_start',
        message: {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      })
      reply({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      reply({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
      reply({ type: 'content_block_stop', index: 0 })
      reply({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      })
      reply({ type: 'message_stop' })
      res.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const child = spawn(process.execPath, [bridgeSource], {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: 'fixture',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        OPL_NATIVE_HARNESS: 'claude',
        OPL_NATIVE_COMMAND: command,
        OPL_NATIVE_MODEL: 'claude-opus-5-5',
        OPL_NATIVE_PERMISSION: 'full-access',
        OPL_NATIVE_IMAGE_INPUT: '1',
        OPL_NATIVE_DIAGNOSTICS: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let diagnostics = ''
    child.stderr.on('data', (chunk) => (diagnostics += String(chunk)))
    const exited = new Promise((done) => child.once('exit', done))
    const pending = new Map()
    const chunks = []
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.method === 'session/update') {
        if (message.params.update.sessionUpdate === 'agent_message_chunk')
          chunks.push(message.params.update.content.text)
      } else if (pending.has(message.id)) {
        const finish = pending.get(message.id)
        pending.delete(message.id)
        message.error
          ? finish.reject(Error(`${message.error.code}; ${diagnostics.slice(-700)}`))
          : finish.resolve(message.result)
      }
    })
    let id = 0
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const key = ++id
        pending.set(key, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
      })
    try {
      await call('initialize')
      const sessionId = '17c19314-288f-41fa-a5cf-6bd3db7c35a1'
      await call('session/load', { cwd, sessionId, mcpServers: [] })
      for (let turn = 0; turn < 2; turn++) {
        assert.equal(
          (
            await call('session/prompt', {
              sessionId,
              prompt:
                turn === 0
                  ? [{ type: 'text', text: 'Reply ok.' }]
                  : [
                      { type: 'text', text: 'Look at this image.' },
                      { type: 'image', data: imageData, mimeType: 'image/png' },
                      { type: 'text', text: 'Reply ok after viewing it.' },
                    ],
            })
          ).stopReason,
          'end_turn',
        )
      }
      assert.equal(chunks.join(''), 'okok')
      assert.equal(requests.length, 2)
      assert.ok(requests.every((item) => item.path?.includes('/v1/messages')))
      const lastUser = requests[1].messages.findLast((item) => item.role === 'user')
      const relevant = lastUser.content.filter(
        (part) =>
          part.type === 'image' ||
          (part.type === 'text' &&
            ['Look at this image.', 'Reply ok after viewing it.'].some((text) =>
              part.text.includes(text),
            )),
      )
      assert.deepEqual(
        relevant.map((part) => part.type),
        ['text', 'image', 'text'],
      )
      assert.equal(relevant[0].text, 'Look at this image.')
      assert.deepEqual(relevant[1], {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: imageData },
      })
      // The CLI appends its own reminder to the final text block.
      assert.ok(relevant[2].text.startsWith('Reply ok after viewing it.'))
      assert.equal(relevant[2].text.split('Reply ok after viewing it.').length, 2)
      const imageHistory = await call('opl/message-edit/read', { sessionId })
      assert.equal(imageHistory.boundaries[1].imageCount, 1)
      assert.equal(imageHistory.boundaries[1].unavailableReason, undefined)
      await call('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'This later turn will be removed.' }],
      })
      const before = await call('opl/message-edit/read', { sessionId })
      const forked = await call('opl/message-edit/rewind', {
        sessionId,
        targetId: before.boundaries[2].id,
        expectedToken: before.token,
      })
      assert.equal(forked.retained.length, 2)
      const after = await call('opl/message-edit/read', { sessionId: forked.sessionId })
      assert.equal(after.boundaries.length, 2)
      assert.equal(after.boundaries[1].imageCount, 1)
      await call('session/prompt', {
        sessionId: forked.sessionId,
        prompt: [{ type: 'text', text: 'Continue with the retained image.' }],
      })
      assert.equal(requests.length, 4)
      const replayedImages = requests[3].messages
        .filter((item) => item.role === 'user')
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .filter((part) => part.type === 'image')
      assert.deepEqual(replayedImages, [relevant[1]])
    } finally {
      child.kill()
      await exited
      await new Promise((resolve) => server.close(resolve))
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
)

/**
 * A local Messages endpoint that asks the real CLI for exactly one Bash call and records the
 * tool result it sends back. No credentials are used and nothing leaves the machine.
 * @param {string[]} results - collects each Bash tool result the CLI reported.
 * @returns {Promise<import('node:http').Server>} the listening fixture server.
 */
async function startBashFixture(results, requestLog = []) {
  let turn = 0
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (!body || !req.url?.includes('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    requestLog.push(JSON.parse(body).messages ?? [])
    for (const message of JSON.parse(body).messages ?? [])
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'tool_result')
          results.push(
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          )
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const reply = (value) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    reply({
      type: 'message_start',
      message: {
        id: 'msg_bash',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    })
    if (turn === 0) {
      turn = 1
      // Only GNU Bash produces this output, so the result proves which shell really ran.
      reply({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} },
      })
      reply({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({
            command: 'echo "OPL_BASH=$BASH_VERSION"; echo "OPL_0=$0"',
          }),
        },
      })
      reply({ type: 'content_block_stop', index: 0 })
      reply({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 1 },
      })
      reply({ type: 'message_stop' })
      res.end()
      return
    }
    reply({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    reply({ type: 'content_block_stop', index: 0 })
    reply({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
    })
    reply({ type: 'message_stop' })
    res.end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return server
}

test(
  'the Git Bash path the bridge builds makes the official Claude Bash tool run Git Bash',
  { skip: !command || process.platform !== 'win32', timeout: 180000 },
  async () => {
    // Build the environment exactly as the bridge does, then hand it to the official CLI.
    const { nativeGitBashEnv } = await import('../src/execution/host/adapters/native-bash.ts')
    const patch = nativeGitBashEnv('claude', 'workspace')
    assert.ok(patch.CLAUDE_CODE_GIT_BASH_PATH, 'expected a resolved Git Bash path')
    assert.match(patch.CLAUDE_CODE_GIT_BASH_PATH, / /, 'expected an absolute path with spaces')

    const home = await mkdtemp(join(tmpdir(), 'opl-claude-git-bash-'))
    const cwd = await realpath(home)
    const results = []
    const server = await startBashFixture(results)
    const child = spawn(
      command,
      [
        '-p',
        'run the probe',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        'claude-opus-5-5',
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Bash',
      ],
      {
        cwd,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          ANTHROPIC_API_KEY: 'fixture-not-a-credential',
          ...patch,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    // Closing stdin lets the CLI finish the one-shot prompt and exit on its own.
    child.stdin.end()
    try {
      await new Promise((done) => {
        child.once('exit', done)
        setTimeout(() => child.kill(), 60000)
      })
      // Each request replays the whole transcript, so assert on the recorded observations.
      assert.ok(results.length > 0, `expected a Bash result; stderr: ${stderr.slice(-600)}`)
      // Real process output from the harness's own Bash tool.
      assert.match(results.join(''), /OPL_BASH=5\.\d/)
      assert.match(results.join(''), /OPL_0=\/usr\/bin\/bash/)
    } finally {
      child.kill()
      await new Promise((done) => server.close(done))
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
) /**
 * A full-access task must reach the official Claude Code CLI with its restricted sandbox off,
 * through the SDK's own full-access mode. Restricted tasks keep the sandbox and must refuse
 * when no Windows sandbox backend exists, rather than being quietly loosened.
 */
test(
  'a full-access Claude task reaches the official CLI with its restricted sandbox off',
  { skip: !command || process.platform !== 'win32', timeout: 240000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'opl-claude-full-access-'))
    const cwd = await realpath(home)
    const results = []
    const server = await startBashFixture(results)
    const child = spawn(process.execPath, [bridgeSource], {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: 'fixture-not-a-credential',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        OPL_NATIVE_HARNESS: 'claude',
        OPL_NATIVE_COMMAND: command,
        OPL_NATIVE_MODEL: 'claude-opus-5-5',
        OPL_NATIVE_PERMISSION: 'full-access',
        OPL_NATIVE_DIAGNOSTICS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    const pending = new Map()
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (pending.has(message.id)) {
        const finish = pending.get(message.id)
        pending.delete(message.id)
        message.error ? finish.reject(Error(message.error.code)) : finish.resolve(message.result)
      }
    })
    let id = 0
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const key = ++id
        pending.set(key, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
      })
    try {
      await call('initialize')
      const session = await call('session/new', { cwd, mcpServers: [] })
      let outcome
      try {
        outcome = await call('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Run the bash probe.' }],
        })
      } catch (error) {
        throw new Error(`${error.message}; bridge diagnostics: ${stderr.slice(-1200)}`)
      }
      assert.deepEqual(outcome, { stopReason: 'end_turn' })
      // The official SDK only emits this notice when the full-access mode is really in
      // effect, because it means every tool call is auto-approved ahead of the gate.
      assert.match(stderr, /permissionMode 'bypassPermissions' auto-approves every tool call/)
      // The restricted sandbox must not be what made this task run.
      assert.doesNotMatch(stderr, /Windows sandbox is not active/)
      assert.doesNotMatch(stderr, /Sandbox required but unavailable/)
    } finally {
      child.kill()
      await new Promise((done) => server.close(done))
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
)

test(
  'a restricted Claude task keeps its sandbox and refuses when no Windows backend is active',
  { skip: !command || process.platform !== 'win32', timeout: 180000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'opl-claude-restricted-'))
    const cwd = await realpath(home)
    const results = []
    const server = await startBashFixture(results)
    const child = spawn(process.execPath, [bridgeSource], {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: 'fixture-not-a-credential',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        OPL_NATIVE_HARNESS: 'claude',
        OPL_NATIVE_COMMAND: command,
        OPL_NATIVE_MODEL: 'claude-opus-5-5',
        OPL_NATIVE_PERMISSION: 'workspace',
        OPL_NATIVE_DIAGNOSTICS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    const pending = new Map()
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (pending.has(message.id)) {
        const finish = pending.get(message.id)
        pending.delete(message.id)
        message.error ? finish.reject(Error(message.error.code)) : finish.resolve(message.result)
      }
    })
    let id = 0
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const key = ++id
        pending.set(key, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
      })
    try {
      await call('initialize')
      const session = await call('session/new', { cwd, mcpServers: [] })
      let refused = null
      try {
        await call('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Run the bash probe.' }],
        })
      } catch (error) {
        refused = error
      }
      // On a machine without an active Windows sandbox backend the restricted task must fail
      // loudly. It must never be silently upgraded to run unsandboxed.
      if (refused) {
        assert.match(stderr, /Sandbox required but unavailable|not active/)
      } else {
        // If a backend is available the restricted task still may not run Bash unsandboxed.
        assert.doesNotMatch(results.join(''), /dangerouslyDisableSandbox/)
      }
    } finally {
      child.kill()
      await new Promise((done) => server.close(done))
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
)
