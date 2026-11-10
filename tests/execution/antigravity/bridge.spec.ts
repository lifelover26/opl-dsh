import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runAntigravityBridge } from '../../../src/execution/host/adapters/antigravity/bridge.ts'

const model = 'gemini-3.8-flash'
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const success = frame({
  candidates: [{ content: { parts: [{ text: 'CURRENT_ANSWER' }] }, finishReason: 'STOP' }],
  usageMetadata: {
    promptTokenCount: 20,
    candidatesTokenCount: 2,
    thoughtsTokenCount: 3,
    totalTokenCount: 25,
  },
})
type ObjectValue = Record<string, any> // The fixture represents untrusted ACP JSON for assertions.

async function start(server: Server) {
  const root = await mkdtemp(join(tmpdir(), 'opl-agy-bridge-'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Fixture server unavailable')
  const input = new PassThrough()
  const output = new PassThrough()
  const messages: ObjectValue[] = []
  const waiters = new Set<() => void>()
  const lines = createInterface({ input: output })
  lines.on('line', (line) => {
    messages.push(JSON.parse(line))
    for (const notify of [...waiters]) notify()
  })
  let sequence = 0
  let invalidated = 0
  let verified = 0
  let disposed = false
  let bridgeError: unknown
  const running = runAntigravityBridge({
    input,
    output,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: root,
      TMP: root,
      OPL_AGY_COMMAND: process.execPath,
      OPL_AGY_ARGS: JSON.stringify([
        fileURLToPath(new URL('./fixtures/agy-cli.mjs', import.meta.url)),
      ]),
      OPL_AGY_ROUTE: JSON.stringify({
        baseURL: `http://127.0.0.1:${address.port}`,
        model,
        apiKey: 'source-secret',
        protocol: 'gemini-native',
        contextWindow: 1000,
      }),
      OPL_AGY_PROFILE: join(root, 'profile'),
      OPL_AGY_WORKSPACE: root,
      OPL_AGY_NODE: process.execPath,
    },
    prepareShell: async (options) => ({
      env: { ...options.env },
      args: [],
      verify: async () => {},
      invalidateInvocation: async () => {
        invalidated++
      },
      verifyInvocation: async () => {
        verified++
      },
      executions: async () => [],
      dispose: async () => {
        disposed = true
      },
    }),
  }).catch((error: unknown) => {
    bridgeError = error
    for (const notify of [...waiters]) notify()
  })
  async function wait(predicate: (message: ObjectValue) => boolean): Promise<ObjectValue> {
    const existing = messages.find(predicate)
    if (existing) return existing
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(observe)
        reject(Error('Owned bridge fixture did not answer'))
      }, 8000)
      const observe = () => {
        const found = messages.find(predicate)
        if (!found && !bridgeError) return
        clearTimeout(timer)
        waiters.delete(observe)
        if (found) resolve(found)
        else reject(bridgeError)
      }
      waiters.add(observe)
      observe()
    })
  }
  const write = (message: object) =>
    input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  function request(method: string, params: object = {}) {
    const id = ++sequence
    write({ id, method, params })
    return wait((message) => message.id === id && !message.method)
  }
  try {
    const initialized = await request('initialize', { protocolVersion: 1 })
    return {
      root,
      initialized,
      request,
      write,
      wait,
      messages,
      stats: () => ({ invalidated, verified, disposed }),
      close: async () => {
        input.end()
        await running
        lines.close()
        output.end()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
        if (bridgeError) throw bridgeError
      },
    }
  } catch (error) {
    input.end()
    await running
    lines.close()
    output.end()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function session(fixture: Awaited<ReturnType<typeof start>>) {
  expect(
    (await fixture.request('authenticate', { methodId: 'gemini-api-key' })).error,
  ).toBeUndefined()
  return fixture.request('session/new', { cwd: fixture.root, mcpServers: [] })
}
const prompt = (text: string) => ({ sessionId: 'owned-session', prompt: [{ type: 'text', text }] })

it('keeps real credentials outside the CLI, filters load replay, and normalizes only current-turn usage', async () => {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    req.resume()
    expect(req.headers['x-goog-api-key']).toBe('source-secret')
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('\r\n' + success)
  })
  const f = await start(server)
  try {
    expect(f.initialized.result.agentInfo.realRouteVisible).toBe(false)
    expect(f.initialized.result.agentInfo.realKeyVisible).toBe(false)
    expect((await f.request('authenticate', { methodId: 'google-login' })).error.code).toBe(-32602)
    await session(f)
    await f.request('session/load', { cwd: f.root, sessionId: 'owned-session', mcpServers: [] })
    expect(
      (
        await f.request('session/set_config_option', {
          sessionId: 'owned-session',
          configId: 'model',
          value: 'gemini-3.1-pro',
        })
      ).error.code,
    ).toBe(-32602)
    const result = await f.request('session/prompt', prompt('aux'))
    expect(result.error).toBeUndefined()
    expect(result.result.stopReason).toBe('end_turn')
    expect(result.result._meta['opl/turnUsage']).toEqual({
      version: 1,
      usage: {
        inputTokens: 2695,
        outputTokens: 61,
        totalTokens: 9046,
        cacheReadTokens: 6290,
        cacheWriteTokens: 0,
        reasoningTokens: 53,
      },
    })
    expect(result.result._meta['opl/contextUsage']).toEqual({
      used: 25,
      size: 1000,
      estimated: true,
    })
    expect(JSON.stringify(f.messages)).not.toContain('OLD_REPLAY')
    expect(JSON.stringify(f.messages)).toContain('CURRENT_ANSWER')
    expect(requests).toBe(1)
    expect(f.stats()).toEqual({ invalidated: 1, verified: 1, disposed: false })
  } finally {
    await f.close()
  }
  expect(f.stats().disposed).toBe(true)
}, 15_000)

it('stops on the first real upstream HTTP failure and never forwards provider text or CLI retries', async () => {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.writeHead(429, { 'content-type': 'application/json' })
    res.flushHeaders()
    res.write('{"error":"source-secret')
  })
  const f = await start(server)
  try {
    await session(f)
    const result = await f.request('session/prompt', prompt('http-error'))
    expect(result.error.code).toBe('HARNESS_PROVIDER_RATE_LIMIT')
    expect(result.error.data.httpStatus).toBe(429)
    expect(result.error.data.oplTurnSettled).toBe(true)
    expect(JSON.stringify(f.messages)).not.toContain('source-secret')
    expect(requests).toBe(1)
  } finally {
    await f.close()
  }
}, 15_000)

it('refuses the CLI terminal-error marker even when it reports end_turn, and leaves ordinary error text alone', async () => {
  const server = createServer((req, res) => {
    req.resume()
    res.end()
  })
  const f = await start(server)
  try {
    await session(f)
    const ordinary = await f.request('session/prompt', prompt('ordinary-error-word'))
    expect(ordinary.result.stopReason).toBe('end_turn')
    const result = await f.request('session/prompt', prompt('terminal-error'))
    expect(result.error.code).toBe('HARNESS_PROVIDER')
    expect(result.error.data.terminalState).toBe('failed')
  } finally {
    await f.close()
  }
}, 15_000)

it('relays a real ACP permission request and only forwards the operator answer', async () => {
  const server = createServer((req, res) => {
    req.resume()
    res.end()
  })
  const f = await start(server)
  try {
    await session(f)
    const result = f.request('session/prompt', prompt('permission'))
    await f.wait((message) => message.method === 'session/request_permission')
    expect(JSON.stringify(f.messages)).not.toContain('DENIED_BY_OPERATOR')
    f.write({
      id: 'owned-permission',
      result: { outcome: { outcome: 'selected', optionId: 'deny' } },
    })
    expect((await result).result.stopReason).toBe('end_turn')
    expect(JSON.stringify(f.messages)).toContain('DENIED_BY_OPERATOR')
  } finally {
    await f.close()
  }
}, 15_000)

it('cancels a stalled upstream request and never treats the resulting error body as success', async () => {
  let entered!: () => void
  let left!: () => void
  const pending = new Promise<void>((resolve) => {
    entered = resolve
  })
  const disconnected = new Promise<void>((resolve) => {
    left = resolve
  })
  const server = createServer((req, res) => {
    req.resume()
    res.once('close', left)
    entered()
  })
  const f = await start(server)
  try {
    await session(f)
    const result = f.request('session/prompt', prompt('hang'))
    await pending
    f.write({ method: 'session/cancel', params: { sessionId: 'owned-session' } })
    expect((await result).result.stopReason).toBe('cancelled')
    await disconnected
    expect(f.messages.filter((message) => message.method === 'session/update')).toEqual([])
  } finally {
    await f.close()
  }
}, 15_000)
