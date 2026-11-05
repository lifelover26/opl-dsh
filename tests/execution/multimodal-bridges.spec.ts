import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpProcess } from '../../src/execution/host/acp.ts'
import { grokAdapter } from '../../src/execution/host/adapters/grok.ts'
import { openCodeAdapter } from '../../src/execution/host/adapters/opencode/opencode.ts'
import { buildOpenCodeRouteConfig } from '../../src/execution/host/adapters/opencode/opencode-route.ts'
import type { AcpPromptPart } from '../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'

const BRIDGE = resolve('src/execution/host/adapters/native-harness-bridge.ts')
const FIXTURE = resolve('tests/execution/multimodal-bridges/wire-agent.mjs')
const IMAGE = {
  type: 'image',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  mimeType: 'image/png',
  uri: 'attachment://owned-image',
} as const
const MIXED: AcpPromptPart[] = [
  { type: 'text', text: 'Compare the first image.' },
  IMAGE,
  { type: 'text', text: 'Against this second image.' },
  { ...IMAGE, uri: 'attachment://second-owned-image' },
  { type: 'text', text: 'Keep this final instruction.' },
]
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})
async function scratch() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'opl-multimodal-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}
async function journal(path: string): Promise<Record<string, any>[]> {
  const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return content.trim()
    ? content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
}

/** Runs the source bridge and installed Claude SDK; the fixture only replaces the CLI. */
async function native(
  kind: 'codex' | 'claude',
  imageInput: '1' | '0' | 'absent' = '1',
  historyContent?: readonly unknown[],
) {
  const cwd = await scratch()
  const log = join(cwd, 'wire.jsonl')
  // Codex's native command receives `app-server --stdio`; Node can execute that local file.
  if (kind === 'codex') await copyFile(FIXTURE, join(cwd, 'app-server'))
  const child = spawn(process.execPath, [BRIDGE], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      USERPROFILE: cwd,
      HOME: cwd,
      CLAUDE_CONFIG_DIR: join(cwd, 'claude'),
      CODEX_HOME: join(cwd, 'codex'),
      OPL_NATIVE_HARNESS: kind,
      OPL_NATIVE_COMMAND: kind === 'codex' ? process.execPath : FIXTURE,
      OPL_NATIVE_MODEL: kind === 'codex' ? 'gpt-wire-model' : 'claude-wire-model',
      OPL_NATIVE_PERMISSION: 'full-access',
      OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
      OPL_NATIVE_API_KEY: 'keyless-wire-fixture',
      OPL_MULTIMODAL_FIXTURE_MODE: kind,
      OPL_MULTIMODAL_WIRE_LOG: log,
      ...(imageInput === 'absent' ? {} : { OPL_NATIVE_IMAGE_INPUT: imageInput }),
      ...(historyContent ? { OPL_MULTIMODAL_HISTORY: JSON.stringify(historyContent) } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += String(chunk)))
  const pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(Error(message.error.code))
    else request.resolve(message.result)
  })
  child.once('exit', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(Error(`Bridge exited: ${stderr.slice(-300)}`))
    }
    pending.clear()
  })
  cleanups.push(async () => {
    const closed = new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) done()
      else child.once('exit', () => done())
    })
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 2000)
    try {
      await closed
    } finally {
      clearTimeout(timer)
      lines.close()
    }
  })
  let id = 0
  const call = (method: string, params: object = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const key = ++id
      const timer = setTimeout(() => {
        pending.delete(key)
        reject(Error(`Timeout: ${method}; ${stderr.slice(-300)}`))
      }, 12000)
      pending.set(key, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
    })
  const agent = await call('initialize')
  const session = await call('session/new', { cwd, mcpServers: [] })
  return {
    agent,
    send: (prompt: readonly unknown[]) =>
      call('session/prompt', { sessionId: session.sessionId, prompt }),
    journal: () => journal(log),
    history: () => call('opl/message-edit/read', { sessionId: session.sessionId }),
  }
}

describe.each(['codex', 'claude'] as const)('%s image bridge wire', (kind) => {
  it.each([{ prompt: MIXED }, { prompt: [IMAGE] }])(
    'preserves image bytes and text order in one prompt %#',
    async ({ prompt }) => {
      const bridge = await native(kind)
      expect(bridge.agent.agentCapabilities.promptCapabilities).toEqual({ image: true })
      expect(await bridge.send(prompt)).toMatchObject({ stopReason: 'end_turn' })
      const wire = await bridge.journal()
      if (kind === 'codex') {
        const turns = wire.filter((item) => item.method === 'turn/start')
        expect(turns).toHaveLength(1)
        expect(turns[0]!.params.input).toEqual(
          prompt.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text, text_elements: [] }
              : { type: 'image', url: `data:${part.mimeType};base64,${part.data}` },
          ),
        )
      } else {
        const users = wire.filter((item) => item.type === 'user')
        expect(users).toHaveLength(1)
        expect(users[0]!.parent_tool_use_id).toBeNull()
        expect(users[0]!.message).toEqual({
          role: 'user',
          content: prompt.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : {
                  type: 'image',
                  source: { type: 'base64', media_type: part.mimeType, data: part.data },
                },
          ),
        })
      }
      expect(JSON.stringify(wire)).not.toContain('attachment://')
      const history = await bridge.history()
      expect(history.boundaries).toEqual([
        expect.objectContaining({
          text: prompt
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(''),
          imageCount: prompt.filter((part) => part.type === 'image').length,
        }),
      ])
      expect(history.boundaries[0].unavailableReason).toBeUndefined()
    },
  )

  it.each(['0', 'absent'] as const)(
    'refuses undeclared image support (%s) before sending a turn',
    async (flag) => {
      const bridge = await native(kind, flag)
      expect(bridge.agent.agentCapabilities.promptCapabilities.image).toBe(false)
      await expect(bridge.send(MIXED)).rejects.toThrow()
      expect(
        (await bridge.journal()).filter(
          (item) => item.method === 'turn/start' || item.type === 'user',
        ),
      ).toEqual([])
      expect(await bridge.send([{ type: 'text', text: 'A plain text turn.' }])).toMatchObject({
        stopReason: 'end_turn',
      })
    },
  )

  it('rejects unsupported or unresolved input without sending partial text', async () => {
    const bridge = await native(kind)
    for (const part of [
      { type: 'image', mimeType: 'image/png', uri: 'file:///private/image.png' },
      { type: 'image', mimeType: 'image/png', uri: 'https://example.test/image.png' },
      { ...IMAGE, data: '!not-base64!' },
      { ...IMAGE, mimeType: 'image/svg+xml' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      {
        type: 'resource',
        resource: { uri: 'file:///private/input.pdf', mimeType: 'application/pdf' },
      },
    ])
      await expect(
        bridge.send([{ type: 'text', text: 'Do not send part of this turn.' }, part]),
      ).rejects.toThrow()
    expect(
      (await bridge.journal()).filter(
        (item) => item.method === 'turn/start' || item.type === 'user',
      ),
    ).toEqual([])
  })

  it.each([
    { type: 'localImage', path: '/private/image.png' },
    { type: 'audio', url: 'data:audio/wav;base64,AAAA' },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' } },
  ])('keeps unsupported $type history unavailable for text editing', async (part) => {
    const bridge = await native(kind, '1', [{ type: 'text', text: 'Imported input.' }, part])
    await bridge.send([{ type: 'text', text: 'Read history.' }])
    const history = await bridge.history()
    expect(history.boundaries[0].unavailableReason).toBeTruthy()
  })
})

describe.each([grokAdapter, openCodeAdapter])('$id ACP image capability', (adapter) => {
  it.each([false, true])(
    'checks the real initialize image flag (%s) before sending',
    async (image) => {
      const cwd = await scratch()
      const log = join(cwd, 'wire.jsonl')
      const acp = new AcpProcess(
        process.execPath,
        [FIXTURE],
        cwd,
        {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          OPL_MULTIMODAL_FIXTURE_MODE: 'acp',
          OPL_MULTIMODAL_ACP_IMAGE: image ? '1' : '0',
          OPL_MULTIMODAL_WIRE_LOG: log,
        },
        () => {},
        () => {},
        () => {},
      )
      cleanups.push(() => acp.dispose())
      const agent = (await acp.request('initialize', { protocolVersion: 1 })) as Record<string, any>
      const snapshot = { agent, session: {}, configOptions: [] }
      const send = async () => {
        adapter.verifyPrompt!({} as HarnessSession, snapshot, MIXED)
        return acp.request('session/prompt', { sessionId: 'fixture', prompt: MIXED })
      }
      if (image) {
        await expect(send()).resolves.toEqual({ stopReason: 'end_turn' })
        expect((await journal(log)).filter((item) => item.method === 'session/prompt')).toEqual([
          expect.objectContaining({ params: { sessionId: 'fixture', prompt: MIXED } }),
        ])
      } else {
        await expect(send()).rejects.toThrow('图片输入能力')
        expect((await journal(log)).filter((item) => item.method === 'session/prompt')).toEqual([])
      }
    },
  )

  it('does not infer image support from an absent advertisement', () => {
    const snapshot = { agent: {}, session: {}, configOptions: [] }
    expect(() => adapter.verifyPrompt!({} as HarnessSession, snapshot, MIXED)).toThrow(
      '图片输入能力',
    )
    expect(() =>
      adapter.verifyPrompt!({} as HarnessSession, snapshot, [{ type: 'text', text: 'text' }]),
    ).not.toThrow()
  })
})

it('declares OpenCode image modality only for an explicitly capable resolved route', () => {
  const route = {
    baseURL: 'https://example.test/v1',
    apiKey: 'fixture',
    protocol: 'chat' as const,
    model: 'vision-model',
  }
  for (const imageInput of [true, false, undefined]) {
    const config = JSON.parse(
      buildOpenCodeRouteConfig(
        { ...route, ...(imageInput === undefined ? {} : { imageInput }) },
        route.model,
      ).content,
    )
    expect(config.provider.oplopencode.models[route.model].modalities).toEqual(
      imageInput === true ? { input: ['text', 'image'], output: ['text'] } : undefined,
    )
  }
})
