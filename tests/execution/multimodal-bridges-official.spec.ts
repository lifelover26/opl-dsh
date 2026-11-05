import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'
import { AcpProcess } from '../../src/execution/host/acp.ts'
import {
  buildOpenCodeRouteConfig,
  openCodeModelValue,
  openCodeProfileRoots,
} from '../../src/execution/host/adapters/opencode/index.ts'

const binary = process.env.OPENCODE_OFFICIAL_BINARY
const codex = process.env.OPL_TEST_CODEX_COMMAND
const image =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})
function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())))
}

it.skipIf(!binary)(
  'official OpenCode accepts the configured image modality and sends ordered Chat image input',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'opl-image-opencode-')))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
    const requests: Record<string, any>[] = []
    const server = createServer(async (req, res) => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [
        { delta: { role: 'assistant', content: 'ok' }, finish_reason: null },
        { delta: {}, finish_reason: 'stop' },
      ])
        res.write(
          `data: ${JSON.stringify({ id: 'image-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`,
        )
      res.end('data: [DONE]\n\n')
    })
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', done)
    })
    cleanups.push(() => closeServer(server))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Fixture failed to bind')
    const model = 'multimodal-fixture-model'
    const config = buildOpenCodeRouteConfig(
      {
        model,
        protocol: 'chat',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'keyless-image-fixture',
        imageInput: true,
      },
      model,
    )
    const acp = new AcpProcess(
      binary!,
      ['acp', '--cwd', root],
      root,
      {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        USERPROFILE: root,
        HOME: root,
        ...openCodeProfileRoots(root),
        OPENCODE_CONFIG_CONTENT: config.content,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
      () => {},
      () => {},
      () => {},
    )
    cleanups.push(() => acp.dispose())
    const init = (await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'opl-image-keyless-fixture', version: '1.0.0' },
    })) as Record<string, any>
    expect(init.agentCapabilities.promptCapabilities.image).toBe(true)
    const session = (await acp.request('session/new', { cwd: root, mcpServers: [] })) as {
      sessionId: string
    }
    await acp.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'model',
      value: openCodeModelValue(model),
    })
    expect(
      await acp.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [
          { type: 'text', text: 'Inspect this image.' },
          { type: 'image', data: image, mimeType: 'image/png' },
          { type: 'text', text: 'Answer ok.' },
        ],
      }),
    ).toMatchObject({ stopReason: 'end_turn' })
    // The CLI also uses this input to generate its title; the task request declares tools.
    const imageRequests = requests.filter((request) =>
      request.messages.some(
        (message: { content: unknown }) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'image_url'),
      ),
    )
    const taskRequests = imageRequests.filter((request) => Array.isArray(request.tools))
    expect(taskRequests).toHaveLength(1)
    expect(taskRequests[0]!.model).toBe(model)
    const user = taskRequests[0]!.messages.findLast(
      (item: { role: string }) => item.role === 'user',
    )
    expect(user.content).toEqual([
      { type: 'text', text: 'Inspect this image.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
      { type: 'text', text: 'Answer ok.' },
    ])
  },
  60000,
)

it.skipIf(!codex).each(process.platform === 'win32' ? ['native', 'cmd'] : ['native'])(
  'installed Codex app-server accepts bridge image input, resume and retained image edits through %s',
  async (launcher) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'opl-image-codex-')))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
    const requests: Record<string, any>[] = []
    const model = 'gpt-6.1-sol'
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
      const message = {
        type: 'message',
        id: 'msg-image-fixture',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'response.created', response: { id: 'resp-image-fixture', status: 'in_progress' } },
        { type: 'response.output_item.done', output_index: 0, item: message },
        {
          type: 'response.completed',
          response: {
            id: 'resp-image-fixture',
            model,
            status: 'completed',
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', done)
    })
    cleanups.push(() => closeServer(server))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Fixture failed to bind')
    const command = launcher === 'cmd' ? join(root, 'Codex image fixture.cmd') : codex!
    if (launcher === 'cmd') await writeFile(command, `@echo off\r\n"${codex}" %*\r\n`)
    const child = spawn(
      process.execPath,
      [resolve('src/execution/host/adapters/native-harness-bridge.ts')],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          USERPROFILE: root,
          HOME: root,
          CODEX_HOME: root,
          OPL_NATIVE_HARNESS: 'codex',
          OPL_NATIVE_COMMAND: command,
          OPL_NATIVE_MODEL: model,
          OPL_NATIVE_PERMISSION: 'full-access',
          OPL_NATIVE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          OPL_NATIVE_API_KEY: 'keyless-image-fixture',
          OPL_NATIVE_IMAGE_INPUT: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    child.stderr.resume()
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    const lines = createInterface({ input: child.stdout })
    const pending = new Map<
      number,
      { method: string; resolve(value: any): void; reject(error: Error): void }
    >()
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error)
        request.reject(Error(`${request.method}: ${JSON.stringify(message.error)}`))
      else request.resolve(message.result)
    })
    let id = 0
    const call = (method: string, params: object = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        const key = ++id
        pending.set(key, { method, resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
      })
    cleanups.push(async () => {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 2000)
      try {
        await exited
      } finally {
        clearTimeout(timer)
        lines.close()
      }
    })
    const initialized = await call('initialize')
    expect(initialized.agentCapabilities.promptCapabilities.image).toBe(true)
    const session = await call('session/new', { cwd: root, mcpServers: [] })
    expect(
      await call('session/prompt', {
        sessionId: session.sessionId,
        prompt: [
          { type: 'text', text: 'Inspect this image.' },
          { type: 'image', data: image, mimeType: 'image/png' },
          { type: 'text', text: 'Answer ok.' },
        ],
      }),
    ).toMatchObject({ stopReason: 'end_turn' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.model).toBe(model)
    const content = requests[0]!.input
      .filter((item: { role?: string }) => item.role === 'user')
      .flatMap((item: { content: unknown[] }) => item.content)
      .filter(
        (part: { type: string; text?: string }) =>
          part.type === 'input_image' ||
          (part.type === 'input_text' &&
            ['Inspect this image.', 'Answer ok.'].includes(part.text!)),
      )
    expect(content).toEqual([
      { type: 'input_text', text: 'Inspect this image.' },
      expect.objectContaining({ type: 'input_image', image_url: `data:image/png;base64,${image}` }),
      { type: 'input_text', text: 'Answer ok.' },
    ])
    const firstHistory = await call('opl/message-edit/read', { sessionId: session.sessionId })
    expect(firstHistory.boundaries).toEqual([
      expect.objectContaining({ text: 'Inspect this image.Answer ok.', imageCount: 1 }),
    ])
    expect(firstHistory.boundaries[0].unavailableReason).toBeUndefined()
    await call('session/load', { cwd: root, sessionId: session.sessionId, mcpServers: [] })
    expect(
      await call('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Continue after the image.' }],
      }),
    ).toMatchObject({ stopReason: 'end_turn' })
    expect(requests).toHaveLength(2)
    expect(requests[1]!.model).toBe(model)
    const retainedImages = requests[1]!.input
      .filter((item: { role?: string }) => item.role === 'user')
      .flatMap((item: { content: unknown[] }) => item.content)
      .filter((part: { type: string }) => part.type === 'input_image')
    expect(retainedImages).toEqual([
      expect.objectContaining({ image_url: `data:image/png;base64,${image}` }),
    ])
    const before = await call('opl/message-edit/read', { sessionId: session.sessionId })
    const rewound = await call('opl/message-edit/rewind', {
      sessionId: session.sessionId,
      targetId: before.boundaries[1].id,
      expectedToken: before.token,
    })
    expect(rewound.retained).toHaveLength(1)
    const after = await call('opl/message-edit/read', { sessionId: session.sessionId })
    expect(after.boundaries).toEqual(firstHistory.boundaries)
  },
  60000,
)
