import { harnessAdapters } from '../../src/execution/host/adapters/index.ts'
import * as harnessRegistry from '../../src/execution/host/harness-registry.ts'
import { beforeEach } from 'vitest'
/**
 * Behavior tests for the official MiniMax Code (`mcode`) ACP combination.
 *
 * Every session test drives the adapter's own launch path against an executable ACP
 * fixture over a real stdio transport, so assertions cover the wire method names, the
 * exact advertised model values, the request order and the child environment rather
 * than the adapter's own constants.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { HarnessSessionStore } from '../../src/execution/host/session-store.ts'
import {
  minimaxCodeAdapter,
  minimaxCodeCombinations,
  minimaxCodeLoggedIn,
  MINIMAX_CODE_HARNESS,
  MINIMAX_CODE_PROVIDER,
} from '../../src/execution/host/adapters/minimax.ts'
import { adapterFor, defaultHarness } from '../../src/execution/host/adapters/index.ts'
import { commandLaunch } from '../../src/execution/host/harness-registry.ts'
import { AcpProcess } from '../../src/execution/host/acp.ts'
import type { AdapterLaunch } from '../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { testPeerConnection } from '../test-peer.ts'

const fixture = resolve('tests/fixtures/minimax-acp-agent.mjs')
const M3_FLASH_COMBINATION = 'minimax-code/MiniMax-M3.1-Flash'
const M3_COMBINATION = 'minimax-code/MiniMax-M3'
const M3_FLASH_VALUE = 'm:minimax:MiniMax-M3.1-Flash:v:thinking'
const M3_VALUE = 'm:minimax:MiniMax-M3:v:thinking'

const cleanups: (() => Promise<unknown>)[] = []
/** Windows keeps a directory locked while a just-killed child still unwinds. */
const removeTree = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length) await cleanups.pop()!()
})

interface Journal {
  method?: string
  event?: string
  configId?: string
  current?: string
  params?: { configId?: string; value?: string }
}

/** One harness service plus the CLI-side state directory it talks to. */
async function setup(
  options: {
    capability?: string
    loggedIn?: boolean
    root?: string
    nativeModel?: string
    nativeMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  } = {},
) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'opl-minimax-'))).replace(/\\/g, '/')
  if (!options.root) cleanups.push(() => removeTree(root))
  const state = join(root, 'cli-state')
  const dataDir = join(root, 'cli-data')
  await mkdir(state, { recursive: true })
  await mkdir(join(dataDir, 'auth', 'en', 'mcode-public'), { recursive: true })
  // The login probe only checks that the CLI's own credential file exists; the test
  // creates an empty placeholder so no real account material is ever read.
  if (options.loggedIn !== false)
    await writeFile(join(dataDir, 'auth', 'en', 'mcode-public', 'auth.json'), '')
  vi.stubEnv('MINIMAX_DATA_DIR', dataDir)

  const current = { provider: MINIMAX_CODE_PROVIDER, model: options.nativeModel ?? 'MiniMax-M3' }
  const ctx = {
    connection: testPeerConnection,
    permissionPresets: { current: () => options.nativeMode ?? 'danger-full-access' },
    sessions: { list: () => [] },
    waterfall: async (_name: unknown, _request: unknown, next: () => Promise<unknown[]>) => next(),
    get: () => undefined,
    agents: {
      list: () => [],
      get: () =>
        options.nativeModel
          ? {
              ctx: {
                get: () => ({
                  resolve: () => ({ mode: options.nativeMode ?? 'danger-full-access' }),
                }),
              },
            }
          : undefined,
    },
    ...(options.nativeModel
      ? {
          sessions: {
            list: () => [],
            get: () => ({ id: 'native-session', header: { cwd: root } }),
          },
          sessionProjections: {
            snapshot: () => ({ values: { modelSelection: { next: current } } }),
          },
          typertGateway: {
            invoke: async () => ({ default: current, groups: [] }),
          },
        }
      : {}),
  } as unknown as Context
  const service = new HarnessService(ctx, {
    home: join(root, 'state'),
    command: process.execPath,
    // The prefix carries the fixture, so `prepare()` builds the real command line.
    prefix: [fixture, '--state', state, '--capability', options.capability ?? 'full'],
  })
  cleanups.push(() => service.dispose())
  const catalog = await service.executionCatalog()
  catalog.harnesses = catalog.harnesses.map((item) =>
    item.id === MINIMAX_CODE_HARNESS ? { ...item, command: process.execPath } : item,
  )
  await service.saveExecutionCatalog(catalog)

  const journal = async (): Promise<Journal[]> =>
    (await readFile(join(state, 'journal.ndjson'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const prompts = async (): Promise<string[]> =>
    (await readFile(join(state, 'prompts.txt'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
  const start = (combination: string, existingSessionId?: string) =>
    service.start({
      combination,
      cwd: root,
      taskId: 'task',
      origin: { kind: 'codex', sessionId: 'parent' },
      sandbox: 'full-access',
      ...(existingSessionId ? { existingSessionId } : {}),
    })
  const ask = async (sessionId: string, text: string, operationId: string) => {
    await service.prompt({ sessionId, text, operationId })
    await service.wait({ sessionId }, AbortSignal.timeout(15000))
    return service.snapshot({ sessionId })
  }
  return { root, state, service, journal, prompts, start, ask, current }
}

const configureCalls = (entries: Journal[]) =>
  entries
    .filter((entry) => entry.method === 'session/set_config_option')
    .map((entry) => `${entry.params?.configId}=${entry.params?.value}`)

describe('official MiniMax Code ACP combination', () => {
  it('streams and persists exact native-turn token usage without carrying it into the next turn', async () => {
    const { service, root, prompts } = await setup({ nativeModel: 'MiniMax-M3.1-Flash' })
    const ask = async (text: string) => {
      const options = {
        sessionId: 'native-session',
        provider: MINIMAX_CODE_PROVIDER,
        model: 'MiniMax-M3.1-Flash',
        messages: [
          createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
        ],
      } as GenerateOptions
      return Array.fromAsync(service.conversationStream(options, async function* () {}))
    }
    const expected = {
      inputTokens: 15,
      outputTokens: 6,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
      totalTokens: 61,
    }
    const first = await ask('USAGE_FIXTURE')
    expect(first.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: expected },
    ])
    const second = await ask('USAGE_FIXTURE_NO_USAGE')
    expect(second.some((chunk) => chunk.type === 'usage')).toBe(false)
    expect(await prompts()).toHaveLength(2)
    await service.dispose()
    const saved = (await new HarnessSessionStore(join(root, 'state')).load()).find(
      (record) => record.origin.sessionId === 'native-session',
    )!
    expect(saved.turns[0]!.usage).toEqual(expected)
    expect(saved.turns[1]!.usage).toBeUndefined()
    expect(saved.turns.every((turn) => turn.state === 'completed')).toBe(true)
  })

  it('streams CLI reasoning separately, retains alternating blocks and title, and never replays an operation', async () => {
    const { service, root, prompts } = await setup({ nativeModel: 'MiniMax-M3.1-Flash' })
    const options = {
      sessionId: 'native-session',
      provider: MINIMAX_CODE_PROVIDER,
      model: 'MiniMax-M3.1-Flash',
      messages: [
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'TRANSCRIPT_FIXTURE' }],
        }),
      ],
    } as GenerateOptions
    const chunks = await Array.fromAsync(service.conversationStream(options, async function* () {}))
    const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    expect(blocks).toEqual([
      { type: 'reasoning', text: 'Inspecting the repository.' },
      { type: 'text', text: 'Starting check.' },
      { type: 'reasoning', text: 'The check passed.' },
      { type: 'text', text: 'TRANSCRIPT_DONE' },
    ])
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.blocks()).toEqual(blocks)
    expect(chunks.some((chunk) => chunk.type === 'reasoning-delta')).toBe(true)
    expect(JSON.stringify(chunks)).not.toContain('WRONG_SESSION')
    await Array.fromAsync(service.conversationStream(options, async function* () {}))
    expect(await prompts()).toHaveLength(1)
    await service.dispose()
    const records = await new HarnessSessionStore(join(root, 'state')).load()
    const saved = records.find((record) => record.origin.sessionId === 'native-session')!
    expect(saved.title).toBe('MiniMax transcript title')
    expect(saved.titleFromHarness).toBe(true)
    expect(saved.turns[0]!.content).toEqual(blocks)
    expect(saved.turns[0]!.text).toBe('Starting check.TRANSCRIPT_DONE')
    expect(saved.turns[0]!.tools[0]).toMatchObject({
      title: 'bash',
      inputJson: JSON.stringify({ command: 'printf TRANSCRIPT_OK' }),
      outputJson: JSON.stringify({
        content: [{ type: 'text', text: 'TRANSCRIPT_OK\n' }],
        details: {
          execution: { status: 'succeeded', exitCode: 0 },
          processOutput: { stdout: 'TRANSCRIPT_OK\n', stderr: '', exitCode: 0 },
        },
      }),
    })
  })
  it.each(['default', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'applies explicit Flash effort %s and preserves it across process recovery',
    async (effort) => {
      const first = await setup()
      const started = await first.start(M3_FLASH_COMBINATION)
      await first.service.prompt(
        { sessionId: started.id, text: 'selected', operationId: 'selected' },
        effort,
      )
      const done = await first.service.wait({ sessionId: started.id }, AbortSignal.timeout(15000))
      expect(done.state).toBe('completed')
      expect(done.reasoningEffort).toBe(effort)
      const entries = await first.journal()
      const promptIndex = entries.findIndex((entry) => entry.method === 'session/prompt')
      const before = entries
        .slice(0, promptIndex)
        .filter((entry) => entry.params?.configId === 'thinkingEffort')
      expect(before.at(-1)?.params?.value).toBe(effort)
      await first.service.dispose()
      const second = await setup({ root: first.root })
      const resumed = await second.start(M3_FLASH_COMBINATION, started.id)
      expect(resumed.reasoningEffort).toBe(effort)
      expect((await second.ask(resumed.id, 'resumed', 'resume')).state).toBe('completed')
      const resumedEntries = await second.journal()
      expect(
        resumedEntries.filter((entry) => entry.params?.configId === 'thinkingEffort').at(-1)?.params
          ?.value,
      ).toBe(effort)
    },
  )
  it('applies M3 thinking off without effort tiers and refuses an unsupported setting', async () => {
    const { service, start, journal } = await setup()
    const started = await start(M3_COMBINATION)
    await service.prompt({ sessionId: started.id, text: 'no thinking', operationId: 'off' }, 'off')
    expect((await service.wait({ sessionId: started.id }, AbortSignal.timeout(15000))).state).toBe(
      'completed',
    )
    const entries = await journal()
    expect(
      entries.filter((entry) => entry.params?.configId === 'model').at(-1)?.params?.value,
    ).toBe('m:minimax:MiniMax-M3:v:')
    expect(entries.some((entry) => entry.params?.configId === 'thinkingEffort')).toBe(false)
    await expect(
      service.prompt({ sessionId: started.id, text: 'invalid', operationId: 'invalid' }, 'high'),
    ).rejects.toThrow('不支持')
    expect((await journal()).filter((entry) => entry.method === 'session/prompt')).toHaveLength(1)
  })
  it.skipIf(process.platform !== 'win32')(
    'refuses an ACP process that ignores Git Bash before sending a prompt',
    async () => {
      for (const capability of ['no-shell', 'wrong-shell']) {
        const { start, prompts } = await setup({ capability })
        await expect(start(M3_FLASH_COMBINATION)).rejects.toThrow(/未确认.*Git Bash/)
        expect(await prompts()).toEqual([])
      }
    },
  )

  it.each(['MiniMax-M3.1-Flash', 'MiniMax-M3'])(
    'executes the actual user request with injected reminders kept as context (%s)',
    async (model) => {
      const { service, prompts, current, journal } = await setup({ nativeModel: model })
      const reminder = (text: string) =>
        createUserMessage({
          source: { kind: 'skill-catalog', form: 'snapshot' } as never,
          content: [{ type: 'text', text }],
        })
      const first = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'explicit-first' }],
      })
      const next = vi.fn(async function* () {})
      const options = {
        sessionId: 'native-session',
        provider: MINIMAX_CODE_PROVIDER,
        model,
        reasoningEffort: model === 'MiniMax-M3' ? 'off' : 'high',
        messages: [first, reminder('injected-catalog')],
      } as GenerateOptions
      await Array.fromAsync(service.conversationStream(options, next))
      expect(
        (await service.list()).sessions
          .find((row) => row.nativeSessionId === 'native-session')
          ?.turns.at(-1)?.reasoningEffort,
      ).toBe(options.reasoningEffort)
      expect((await prompts()).join('\n')).toContain('当前用户请求：')
      expect((await prompts()).join('\n')).toContain('user: explicit-first')
      const second = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'explicit-second' }],
      })
      const followup = {
        ...options,
        messages: [...options.messages, second, reminder('updated-context')],
      }
      await Array.fromAsync(service.conversationStream(followup, next))
      const sent = (await prompts()).join('\n')
      expect(sent).toContain('updated-context')
      expect(sent.endsWith('user: explicit-second')).toBe(true)
      const before = await prompts()
      await Array.fromAsync(
        service.conversationStream(
          {
            ...followup,
            messages: [...followup.messages, reminder('another-frame-without-user-input')],
          },
          next,
        ),
      )
      expect(await prompts()).toEqual(before)
      expect(next).not.toHaveBeenCalled()
    },
  )
  it.each([undefined, 'read-only', 'workspace'] as const)(
    'refuses a request without explicit full access before starting the CLI (%s)',
    async (sandbox) => {
      const { service, root, journal } = await setup()
      await expect(
        service.start({
          combination: M3_FLASH_COMBINATION,
          cwd: root,
          origin: { kind: 'codex', sessionId: 'parent' },
          ...(sandbox ? { sandbox } : {}),
        }),
      ).rejects.toThrow(/显式授权 full-access/)
      expect(await journal()).toEqual([])
    },
  )

  it.each(['read-only', 'workspace-write'] as const)(
    'refuses native conversations under a restricted DSH policy (%s)',
    async (nativeMode) => {
      const { service, journal } = await setup({ nativeModel: 'MiniMax-M3', nativeMode })
      await expect(
        Array.fromAsync(
          service.conversationStream(
            {
              sessionId: 'native-session',
              provider: MINIMAX_CODE_PROVIDER,
              model: 'MiniMax-M3',
              messages: [
                createUserMessage({
                  source: { kind: 'user' },
                  content: [{ type: 'text', text: 'blocked' }],
                }),
              ],
            } as GenerateOptions,
            async function* () {},
          ),
        ),
      ).rejects.toThrow(/full-access/)
      expect(await journal()).toEqual([])
    },
  )

  it('keeps explicit full access on an external continuation without repeating the permission flag', async () => {
    const { service, root } = await setup()
    const origin = { kind: 'codex', sessionId: 'parent' } as const
    const input = {
      combination: M3_COMBINATION,
      cwd: root,
      taskId: 'delegated',
      operationId: 'initial',
      task: 'hello',
      sandbox: 'full-access',
      wait: true,
    }
    const initial = await service.delegateFrom(origin, input)
    const next = await service.delegateFrom(origin, {
      ...input,
      sandbox: undefined,
      sessionId: initial.id,
      operationId: 'next',
      task: 'again',
    })
    expect(next.sandbox).toBe('full-access')
    expect(next.turns.at(-1)?.state).toBe('completed')
  })

  it('preserves a legacy restricted record and refuses to load it into the CLI', async () => {
    const first = await setup()
    const started = await first.start(M3_COMBINATION)
    await first.service.dispose()
    const store = new HarnessSessionStore(join(first.root, 'state'))
    const saved = (await store.load()).find((record) => record.id === started.id)!
    saved.sandbox = 'workspace'
    await store.saveChanged([saved])
    const bytes = await readFile(store.filename(saved.id), 'utf8')
    const second = await setup({ root: first.root })
    const before = await second.journal()
    await expect(
      second.service.start({
        combination: M3_COMBINATION,
        cwd: first.root,
        existingSessionId: saved.id,
      }),
    ).rejects.toThrow(/full-access/)
    expect(await second.journal()).toEqual(before)
    expect(await readFile(store.filename(saved.id), 'utf8')).toBe(bytes)
  })

  it('serializes full-access writers in the same project and releases the queue after cancellation', async () => {
    const { service, root, start, prompts } = await setup()
    const first = await start(M3_COMBINATION)
    const second = await service.start({
      combination: M3_COMBINATION,
      cwd: root,
      taskId: 'second',
      origin: { kind: 'codex', sessionId: 'parent' },
      sandbox: 'full-access',
    })
    await service.prompt({ sessionId: first.id, operationId: 'wait', text: 'wait' })
    await service.prompt({ sessionId: second.id, operationId: 'queued', text: 'after' })
    expect((await service.snapshot({ sessionId: second.id })).state).toBe('queued')
    await service.cancel({ sessionId: first.id })
    await service.wait({ sessionId: second.id }, AbortSignal.timeout(15000))
    expect((await service.snapshot({ sessionId: second.id })).state).toBe('completed')
    expect(await prompts()).toContain('after')
  }, 30_000)

  it.each(['MiniMax-M3.1-Flash', 'MiniMax-M3'])(
    'routes native model selection to the official CLI without a saved combination (%s)',
    async (model) => {
      const { service, prompts, current, journal } = await setup({ nativeModel: model })
      const selection = await service.modelSelection('native-session')
      expect(selection.combination).toBe(`minimax-code/${model}`)
      const next = vi.fn(async function* () {})
      const options = {
        sessionId: 'native-session',
        provider: MINIMAX_CODE_PROVIDER,
        model,
        messages: [
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'native-input' }],
          }),
        ],
      } as GenerateOptions
      const chunks = await Array.fromAsync(service.conversationStream(options, next))
      expect(next).not.toHaveBeenCalled()
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(await prompts()).toHaveLength(1)
      expect((await prompts())[0]).toContain('native-input')
      await Array.fromAsync(service.conversationStream(options, next))
      expect(await prompts()).toHaveLength(1)
      current.provider = 'opl-gateway'
      current.model = 'kiro::claude-opus-5-5'
      const before = await journal()
      expect(await service.stopEditState({ sessionId: 'native-session' })).toMatchObject({
        supported: false,
        boundaries: [],
        reason: '该会话不是可编辑的侧栏对话',
      })
      expect(await journal()).toEqual(before)
    },
  )

  it('pins the thinking model and max effort on a new session before any prompt', async () => {
    const { service, journal, prompts, start, ask } = await setup()
    const started = await start(M3_FLASH_COMBINATION)
    expect(started.acpSessionId).toBeTruthy()
    expect(await prompts()).toEqual([])

    const entries = await journal()
    expect(configureCalls(entries)).toEqual([
      `model=${M3_FLASH_VALUE}`,
      'thinkingEffort=max',
      'permissionMode=bypassPermissions',
    ])
    // The effort that makes the combination correct is fixed before the first prompt.
    const effortIndex = entries.findIndex((entry) => entry.params?.configId === 'thinkingEffort')
    expect(effortIndex).toBeGreaterThanOrEqual(0)
    expect(entries.find((entry) => entry.event === 'session/new')).toBeTruthy()

    const done = await ask(started.id, 'hello', 'op-1')
    expect(done.turns[0]?.state).toBe('completed')
    expect(done.turns[0]?.text).toBe('result:hello')
    expect(await prompts()).toEqual(['hello'])
    const promptIndex = (await journal()).findIndex((entry) => entry.method === 'session/prompt')
    expect(promptIndex).toBeGreaterThan(effortIndex)
  })

  it('re-asserts the fixed combination before every prompt instead of trusting cache', async () => {
    const { journal, start, ask } = await setup()
    const started = await start(M3_FLASH_COMBINATION)
    await ask(started.id, 'one', 'op-1')
    await ask(started.id, 'two', 'op-2')

    const entries = await journal()
    expect(entries.filter((entry) => entry.method === 'session/prompt')).toHaveLength(2)
    // Connect pins model then effort; the already-correct effort is read back from the
    // agent's own response rather than re-written, and the model is always re-confirmed.
    expect(configureCalls(entries)).toEqual([
      `model=${M3_FLASH_VALUE}`,
      'thinkingEffort=max',
      'permissionMode=bypassPermissions',
      `model=${M3_FLASH_VALUE}`,
      `model=${M3_FLASH_VALUE}`,
    ])
  })

  it('selects the M3 thinking variant and never touches a thinking effort control', async () => {
    const { journal, start, ask } = await setup()
    const started = await start(M3_COMBINATION)
    await ask(started.id, 'hi', 'op-1')
    const calls = configureCalls(await journal())
    // Connect pins the variant, and the pre-prompt check re-confirms it; M3 declares no
    // effort levels, so the suite must never invent one.
    expect(calls).toEqual([
      `model=${M3_VALUE}`,
      'permissionMode=bypassPermissions',
      `model=${M3_VALUE}`,
    ])
    expect(calls.some((call) => call.startsWith('thinkingEffort'))).toBe(false)
  })

  it('re-pins the same model and effort when a session is resumed by a fresh process', async () => {
    const first = await setup()
    const started = await first.start(M3_FLASH_COMBINATION)
    await first.service.dispose()

    // A second service over the same home is a different process view: it must load the
    // native session and decide the configuration from what the CLI reports now.
    const second = await setup({ root: first.root })
    const resumed = await second.start(M3_FLASH_COMBINATION, started.id)
    expect(resumed.acpSessionId).toBe(started.acpSessionId)

    const entries = await second.journal()
    expect(entries.some((entry) => entry.event === 'session/load')).toBe(true)
    expect(configureCalls(entries)).toContain(`model=${M3_FLASH_VALUE}`)
    // The reloaded session still finishes a turn, which the adapter only allows after it
    // has confirmed both the model and the max effort on the live session.
    const done = await second.ask(resumed.id, 'after-resume', 'op-1')
    expect(done.turns[0]?.state).toBe('completed')
    expect(await second.prompts()).toEqual(['after-resume'])
  })

  it('fails without sending a prompt when the CLI advertises no model option', async () => {
    const { start, prompts } = await setup({ capability: 'no-model-option' })
    await expect(start(M3_FLASH_COMBINATION)).rejects.toThrow(/mcode 0\.7\.4/)
    expect(await prompts()).toEqual([])
  })

  it('fails without sending a prompt when the Flash model is not advertised', async () => {
    const { start, prompts } = await setup({ capability: 'legacy-models' })
    await expect(start(M3_FLASH_COMBINATION)).rejects.toThrow(/MiniMax-M3\.1-Flash/)
    expect(await prompts()).toEqual([])
  })

  it('fails without sending a prompt when the CLI advertises no thinking effort', async () => {
    const { start, prompts } = await setup({ capability: 'no-effort' })
    await expect(start(M3_FLASH_COMBINATION)).rejects.toThrow(/thinkingEffort/)
    expect(await prompts()).toEqual([])
  })

  it('sets authorized Full access before prompting without answering a permission request', async () => {
    const { journal, start, ask } = await setup()
    const started = await start(M3_FLASH_COMBINATION)
    await ask(started.id, 'hi', 'op-1')
    const entries = await journal()
    expect(configureCalls(entries).filter((call) => call.startsWith('permissionMode'))).toEqual([
      'permissionMode=bypassPermissions',
    ])
    expect(entries.findIndex((entry) => entry.event === 'permission-mode')).toBeLessThan(
      entries.findIndex((entry) => entry.method === 'session/prompt'),
    )
    expect(entries.some((entry) => entry.method === 'response')).toBe(false)
  })

  it('keeps an official CLI approval waiting until an explicit decision and forwards rejection', async () => {
    const { service, start, journal } = await setup()
    const started = await start(M3_COMBINATION)
    await service.prompt({ sessionId: started.id, text: 'approval', operationId: 'approval' })
    const waiting = await service.wait({ sessionId: started.id }, AbortSignal.timeout(15000))
    expect(waiting.state).toBe('waiting_approval')
    expect(waiting.approvals).toHaveLength(1)
    expect(
      (await journal()).filter(
        (entry) => entry.method === 'response' && entry.params === undefined,
      ),
    ).toEqual([])
    await service.answer({
      sessionId: started.id,
      approvalId: waiting.approvals[0]!.id,
      optionId: 'no',
    })
    const done = await service.wait({ sessionId: started.id }, AbortSignal.timeout(15000))
    expect(done.turns.at(-1)?.text).toBe('denied')
    expect((await journal()).find((entry) => entry.event === 'permission-answer')?.current).toBe(
      'no',
    )
  })

  it.each(['refuse-effort', 'wrong-effort'])(
    'refuses an unconfirmed fixed effort without reflecting provider diagnostics (%s)',
    async (capability) => {
      const { start, prompts } = await setup({ capability })
      const error = await start(M3_FLASH_COMBINATION).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/thinkingEffort|max/)
      expect((error as Error).message).not.toContain('private-account-diagnostic')
      expect(await prompts()).toEqual([])
    },
  )

  it('stops before a later prompt if the live CLI refuses to re-pin its model', async () => {
    const { state, journal, prompts, start, ask } = await setup()
    const started = await start(M3_FLASH_COMBINATION)
    await ask(started.id, 'first', 'op-1')
    await writeFile(join(state, 'refuse-config'), '')
    const done = await ask(started.id, 'must-not-send', 'op-2')
    expect(done.turns[1]?.state).toBe('failed')
    expect(done.turns[1]?.error).toMatch(/未发送任何任务/)
    expect(done.turns[1]?.error).not.toContain('private-account-diagnostic')
    expect(await prompts()).toEqual(['first'])
    expect((await journal()).filter((entry) => entry.method === 'session/prompt')).toHaveLength(1)
  })

  it('never injects an OPL Gateway credential into the official CLI process', async () => {
    const { root, state } = await setup()
    vi.stubEnv('OPL_GATEWAY_GROK_API_KEY', 'must-not-inherit')
    vi.stubEnv('OPL_GATEWAY_CODEX_API_KEY', 'must-not-inherit')
    vi.stubEnv('OPL_GATEWAY_AWS_API_KEY', 'must-not-inherit')
    const launch = await prepareFor(root, {
      command: process.execPath,
      prefix: [fixture, '--state', state, '--capability', 'full'],
    })
    const names = Object.keys(launch.env)
    for (const name of names) expect(name).not.toMatch(/OPL_GATEWAY|API_KEY|TOKEN|SECRET/)
    expect(launch.env.OPL_GATEWAY_GROK_API_KEY).toBeUndefined()
    // The CLI still receives the environment it needs to find its own data directory.
    expect(launch.env.MINIMAX_DATA_DIR).toBe(join(root, 'cli-data'))
  })
})

/** Build the adapter launch for one fixed combination, to assert on the child env. */
async function prepareFor(
  cwd: string,
  options: { command: string; prefix?: string[] },
): Promise<AdapterLaunch> {
  const record = {
    id: 'env-probe',
    cwd,
    sandbox: 'full-access',
    harnessRef: MINIMAX_CODE_HARNESS,
    modelRef: { provider: MINIMAX_CODE_PROVIDER, model: 'MiniMax-M3' },
  } as HarnessSession
  return minimaxCodeAdapter.prepare!({} as Context, record, {
    home: cwd,
    command: options.command,
    ...(options.prefix ? { prefix: options.prefix } : {}),
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.mjs',
  })
}

describe('MiniMax Code adapter registration', () => {
  it('binds both fixed models to the official CLI and to nothing else', () => {
    expect(minimaxCodeCombinations().map((item) => item.combination)).toEqual([
      M3_FLASH_COMBINATION,
      M3_COMBINATION,
    ])
    for (const item of minimaxCodeCombinations()) {
      const ref = { provider: MINIMAX_CODE_PROVIDER, model: item.model }
      expect(adapterFor(MINIMAX_CODE_HARNESS, ref)?.id).toBe(MINIMAX_CODE_HARNESS)
      // Automatic routing must reach the official CLI, never the fallback DSH loop.
      expect(defaultHarness(ref)).toBe(MINIMAX_CODE_HARNESS)
      expect(adapterFor('codex', ref)).toBeUndefined()
      expect(adapterFor('claude', ref)).toBeUndefined()
    }
  })

  it('keeps the existing official CLI routing unchanged', () => {
    const gpt = { provider: 'opl-gateway', model: 'codex::gpt-current' }
    const claude = { provider: 'opl-gateway', model: 'aws::claude-sonnet-current' }
    const grok = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
    expect(adapterFor('codex', gpt)?.id).toBe('codex')
    expect(adapterFor('claude', claude)?.id).toBe('claude')
    expect(adapterFor('grok-build', grok)?.id).toBe('grok-build')
    expect(adapterFor(MINIMAX_CODE_HARNESS, gpt)).toBeUndefined()
    expect(defaultHarness(gpt)).toBe('codex')
    expect(defaultHarness(claude)).toBe('claude')
    expect(defaultHarness(grok)).toBe('grok-build')
    expect(defaultHarness({ provider: 'custom', model: 'gpt-current' })).toBe('dsh')
  })
})

describe('MiniMax Code availability reporting', () => {
  it('reports an actionable, Gateway-free reason when the CLI is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-minimax-absent-'))
    cleanups.push(() => removeTree(root))
    vi.stubEnv('USERPROFILE', root)
    vi.stubEnv('HOME', root)
    vi.stubEnv('MINIMAX_DATA_DIR', root)
    vi.stubEnv('PATH', '')
    const result = await minimaxCodeAdapter.available({} as Context, {
      home: root,
      command: join(root, 'missing-mcode'),
      grokCommand: 'grok',
      nativeBridgePath: 'bridge.mjs',
    })
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/mcode/)
    expect(result.reason).toMatch(/MiniMax 官方安装器/)
    // An absent CLI must never be reported as a Gateway credential problem.
    expect(result.reason).not.toMatch(/刷新账号|凭据未就绪|401/)
  })

  it('reports the official login flow instead of a Gateway credential problem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-minimax-login-'))
    cleanups.push(() => removeTree(root))
    vi.stubEnv('MINIMAX_DATA_DIR', join(root, 'empty-data'))
    const result = await minimaxCodeAdapter.available({} as Context, {
      home: root,
      command: process.execPath,
      grokCommand: 'grok',
      nativeBridgePath: 'bridge.mjs',
    })
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/mcode login/)
    expect(result.reason).not.toMatch(/Gateway|401/i)
  })

  it('honors an explicit data directory without falling back to the default one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-minimax-override-'))
    cleanups.push(() => removeTree(root))
    const home = join(root, 'home')
    const explicit = join(root, 'explicit')
    await mkdir(join(home, '.minimax', 'auth', 'en', 'mcode-public'), { recursive: true })
    await writeFile(join(home, '.minimax', 'auth', 'en', 'mcode-public', 'auth.json'), '')
    await mkdir(explicit, { recursive: true })
    // The default directory holds a credential, but the CLI was pointed elsewhere: a
    // stale login must not be reported as the account this process would actually use.
    expect(await minimaxCodeLoggedIn({ HOME: home, MINIMAX_DATA_DIR: explicit })).toBe(false)
    expect(await minimaxCodeLoggedIn({ HOME: home })).toBe(true)
  })

  it('reports available once the CLI exists and its own credential file is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-minimax-ready-'))
    cleanups.push(() => removeTree(root))
    vi.stubEnv('MINIMAX_DATA_DIR', join(root, 'cli-data'))
    await mkdir(join(root, 'cli-data', 'auth', 'en', 'mcode-public'), { recursive: true })
    await writeFile(join(root, 'cli-data', 'auth', 'en', 'mcode-public', 'auth.json'), '')
    const result = await minimaxCodeAdapter.available({} as Context, {
      home: root,
      command: process.execPath,
      grokCommand: 'grok',
      nativeBridgePath: 'bridge.mjs',
    })
    expect(result.available).toBe(true)
  })
})

describe('Windows script launch', () => {
  it('runs a cmd shim with a verbatim, fully quoted argument vector', () => {
    const script = 'C:\\Program Files Extra\\MiniMax Code\\mcode.cmd'
    const launch = commandLaunch(script, ['--state', 'C:\\Temp\\has space\\state', 'acp'])
    if (process.platform !== 'win32') {
      expect(launch.command).toBe(script)
      expect(launch.args).toEqual(['--state', 'C:\\Temp\\has space\\state', 'acp'])
      expect(launch.windowsVerbatimArguments).toBeUndefined()
      return
    }
    expect(launch.command).toBe('cmd.exe')
    expect(launch.windowsVerbatimArguments).toBe(true)
    expect(launch.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    // cmd /S strips only the outermost pair, so the script path keeps a second pair and
    // every argument containing a space carries its own quotes.
    expect(launch.args[3]).toBe(
      '""C:\\Program Files Extra\\MiniMax Code\\mcode.cmd" --state "C:\\Temp\\has space\\state" acp"',
    )
  })

  it('refuses an argument cmd.exe would reinterpret', () => {
    if (process.platform !== 'win32') return
    expect(() => commandLaunch('C:\\tools\\mcode.cmd', ['a&del *'])).toThrow(/cmd\.exe/)
  })

  it('leaves a real executable unwrapped', () => {
    const launch = commandLaunch(process.execPath, ['--version'])
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual(['--version'])
    expect(launch.windowsVerbatimArguments).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')(
    'negotiates ACP through a cmd shim whose path contains spaces',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'opl-minimax-shim-'))
      cleanups.push(() => removeTree(root))
      const install = join(root, 'Program Files Extra', 'MiniMax Code')
      const state = join(install, 'cli state')
      await mkdir(state, { recursive: true })
      const shim = join(install, 'mcode.cmd')
      await writeFile(
        shim,
        `@echo off\r\n"${process.execPath}" "${fixture}" --state "${state}" %*\r\n`,
      )
      const launch = await prepareFor(root, { command: shim })
      expect(launch.command).toBe('cmd.exe')
      expect(launch.windowsVerbatimArguments).toBe(true)
      // Drive the real transport through the shim to prove the quoting actually works.
      const acp = new AcpProcess(
        launch.command,
        launch.args,
        root,
        launch.env,
        () => {},
        () => {},
        () => {},
        launch.windowsVerbatimArguments,
      )
      cleanups.push(() => acp.dispose())
      const init = (await acp.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'test', version: '0' },
      })) as Record<string, any>
      expect(init.protocolVersion).toBe(1)
      expect(init.agentInfo?.version).toBe('0.7.4')
      const cliPid = init.fixturePid
      expect(typeof cliPid).toBe('number')
      expect(() => process.kill(cliPid, 0)).not.toThrow()
      await Promise.all([acp.dispose(), acp.dispose()])
      expect(() => process.kill(cliPid, 0)).toThrow()
      expect(() => process.kill(process.pid, 0)).not.toThrow()
    },
  )
})

// These suites exercise other harnesses; their catalog must not probe a personal ZCode install.
beforeEach(() => {
  vi.spyOn(harnessRegistry, 'inspectHarness').mockImplementation(async (definition) => ({
    id: definition.id,
    name: definition.name,
    installed: true,
    runnable: true,
    path: definition.command ?? process.execPath,
    instructions: 'fixture',
    website: 'https://example.test',
  }))
  vi.spyOn(
    harnessAdapters.find((adapter) => adapter.id === 'zcode')!,
    'available',
  ).mockResolvedValue({ available: false, reason: 'ZCode outside this fixture' })
})
