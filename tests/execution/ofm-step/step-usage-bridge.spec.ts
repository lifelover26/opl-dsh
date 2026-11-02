/** Usage through the real ACP transport and a private Step RPC event fixture. */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessRequestError } from '../../../src/execution/host/acp.ts'
import { stepStorage } from '../../../src/execution/host/adapters/step/step-config.ts'
import {
  STEP_TEST_KEY,
  startStepAgent,
  stepTempDir,
  stepTestCleanup,
  type StepAgent,
} from './fixtures/agent.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })
afterAll(() => stepTestCleanup())

const STUB = fileURLToPath(new URL('./fixtures/stub-step-usage-rpc.mjs', import.meta.url))
const windowSize = 262_144
const usage = { input: 100, output: 10, cacheRead: 20, cacheWrite: 5, totalTokens: 135 }
const normalized = {
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 20,
  cacheWriteTokens: 5,
  totalTokens: 135,
}

interface Turn {
  events?: Record<string, unknown>[]
  contextUsage?: unknown
  waitForAbort?: boolean
  abortEvents?: Record<string, unknown>[]
  statsFailure?: 'rejected' | 'silent'
  rejected?: boolean
}

interface Result {
  sessionId?: string
  stopReason?: string
  _meta?: Record<string, unknown>
}

const assistant = (timestamp: number, fields: Record<string, unknown> = {}) => ({
  role: 'assistant',
  timestamp,
  content: [{ type: 'text', text: `response-${timestamp}` }],
  usage,
  stopReason: 'stop',
  ...fields,
})
const completed = (message: Record<string, unknown>): Record<string, unknown>[] => [
  { type: 'message_start', message: { ...message, usage: undefined } },
  { type: 'message_end', message },
]
const chunk = (text: string) => ({
  type: 'message_update',
  usage: { input: 900_000, output: 900_000 },
  assistantMessageEvent: { type: 'text_delta', delta: text },
})
const prompt = (agent: StepAgent, sessionId: string) =>
  agent.acp.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'one prompt' }],
  }) as Promise<Result>

async function start(options: {
  turns: Turn[]
  home?: string
  initialContext?: unknown
  sourceCapacity?: number
}): Promise<{ agent: StepAgent; home: string; open(load?: boolean): Promise<Result> }> {
  const home = options.home ?? stepTempDir('step-usage-home-')
  const storage = stepStorage(home)
  for (const dir of Object.values(storage)) mkdirSync(dir, { recursive: true })
  const scratch = join(home, 'tmp')
  mkdirSync(scratch, { recursive: true })
  writeFileSync(
    join(storage.agentDir, 'usage-scenario.json'),
    JSON.stringify({ effectiveWindow: windowSize, ...options }),
  )
  const agent = await startStepAgent({
    cwd: home,
    env: {
      PATH: process.env.PATH ?? '',
      OPL_STEP_COMMAND: process.execPath,
      OPL_STEP_PREFIX: JSON.stringify([STUB]),
      OPL_STEP_AGENT_DIR: storage.agentDir,
      OPL_STEP_CONFIG_ROOT: storage.configRoot,
      OPL_STEP_SESSION_DIR: storage.sessionDir,
      OPL_STEP_SESSION_INDEX_DIR: storage.sessionIndexDir,
      OPL_STEP_PROVIDER: 'opl-step-free-lane',
      OPL_STEP_MODEL: 'step-5-preview-free',
      OPL_STEP_BASE_URL: 'https://model.test/v1',
      OPL_STEP_API: 'openai-completions',
      OPL_STEP_PRESET: 'ask',
      OPL_STEP_CREDENTIAL: STEP_TEST_KEY,
      ...(options.sourceCapacity === undefined
        ? {}
        : { OPL_STEP_CONTEXT_WINDOW: String(options.sourceCapacity) }),
      STEPCODE_STORAGE_ROOT_DIR: storage.storageRoot,
      TEMP: scratch,
      TMP: scratch,
    },
  })
  return {
    agent,
    home,
    async open(load = false) {
      await agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      return (await agent.acp.request(load ? 'session/load' : 'session/new', {
        ...(load ? { sessionId: 'step-usage-session' } : {}),
        cwd: home,
        mcpServers: [],
      })) as Result
    },
  }
}

function commands(home: string): string[] {
  return readFileSync(join(stepStorage(home).agentDir, 'usage-rpc-commands.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string)
}

describe('Step statistics through ACP', () => {
  it('owns two turns independently across tools, retries, duplicate frames, and compaction', async () => {
    const first = assistant(1, {
      responseId: 'response-1',
      stopReason: 'toolUse',
      content: [
        { type: 'toolCall', id: 'one', name: 'search' },
        { type: 'toolCall', id: 'two', name: 'read' },
      ],
    })
    const tool = {
      role: 'toolResult',
      toolCallId: 'one',
      toolName: 'search',
      timestamp: 2,
      usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 13 },
    }
    const final = assistant(4, {
      responseId: 'response-2',
      usage: { input: 180, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 250 },
    })
    const run = await start({
      sourceCapacity: windowSize,
      turns: [
        {
          events: [
            ...completed(first),
            chunk('first-stream'),
            chunk('second-stream'),
            ...completed(tool),
            ...completed({ role: 'toolResult', toolCallId: 'two', toolName: 'read', timestamp: 3 }),
            { type: 'turn_end', message: first, toolResults: [tool] },
            { type: 'agent_end', messages: [first, tool], willRetry: true },
            { type: 'auto_retry_start', attempt: 1 },
            ...completed(final),
            ...completed(final),
            { type: 'auto_retry_end', success: true },
          ],
          contextUsage: { tokens: 320, contextWindow: windowSize, percent: 0.12 },
        },
        {
          events: [
            ...completed(
              assistant(5, { usage: { input: 8, output: 3, cacheRead: 2, cacheWrite: 1 } }),
            ),
            { type: 'compaction_start', reason: 'threshold' },
            {
              type: 'compaction_end',
              result: {
                usage: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 10 },
              },
            },
          ],
          contextUsage: { tokens: null, percent: null, contextWindow: windowSize },
        },
      ],
    })
    try {
      const session = await run.open()
      const firstResult = await prompt(run.agent, session.sessionId!)
      expect(firstResult._meta?.['opl/turnUsage']).toEqual({
        version: 1,
        usage: {
          inputTokens: 287,
          outputTokens: 32,
          cacheReadTokens: 73,
          cacheWriteTokens: 6,
          totalTokens: 398,
        },
      })
      expect(firstResult._meta?.['opl/contextUsage']).toEqual({
        used: 320,
        size: windowSize,
        estimated: true,
      })
      const secondResult = await prompt(run.agent, session.sessionId!)
      expect(secondResult._meta?.['opl/turnUsage']).toEqual({
        version: 1,
        usage: {
          inputTokens: 12,
          outputTokens: 6,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          totalTokens: 24,
        },
      })
      expect(secondResult._meta?.['opl/contextUsage']).toEqual({
        size: windowSize,
        estimated: true,
      })
      expect(run.agent.all()).toContainEqual({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: 320,
          size: windowSize,
          _meta: { 'opl/contextEstimated': true },
        },
      })
      expect(commands(run.home).filter((name) => name === 'prompt')).toHaveLength(2)
      const config = JSON.parse(
        readFileSync(join(stepStorage(run.home).configRoot, 'models.json'), 'utf8'),
      )
      expect(config.providers['opl-step-free-lane'].models[0].contextWindow).toBe(windowSize)
    } finally {
      await run.agent.dispose()
    }
  })

  it('refreshes context on reload without charging replayed historical assistant messages', async () => {
    const first = await start({
      turns: [{ events: [...completed(assistant(1)), chunk('old response')] }],
    })
    try {
      const session = await first.open()
      await prompt(first.agent, session.sessionId!)
    } finally {
      await first.agent.dispose()
    }
    const loaded = await start({
      home: first.home,
      initialContext: { tokens: 840, contextWindow: windowSize },
      turns: [{ events: completed(assistant(2, { usage: { input: 8, output: 3 } })) }],
    })
    try {
      const session = await loaded.open(true)
      expect(session._meta?.['opl/turnUsage']).toBeUndefined()
      expect(session._meta?.['opl/contextUsage']).toEqual({
        used: 840,
        size: windowSize,
        estimated: true,
      })
      expect(JSON.stringify(loaded.agent.all())).toContain('response-1')
      const result = await prompt(loaded.agent, session.sessionId!)
      expect(result._meta?.['opl/turnUsage']).toEqual({
        version: 1,
        usage: { inputTokens: 8, outputTokens: 3 },
      })
      const config = JSON.parse(
        readFileSync(join(stepStorage(loaded.home).configRoot, 'models.json'), 'utf8'),
      )
      expect(config.providers['opl-step-free-lane'].models[0]).not.toHaveProperty('contextWindow')
    } finally {
      await loaded.agent.dispose()
    }
  })

  it('keeps completed work when cancellation interrupts the next model call', async () => {
    const run = await start({
      turns: [
        {
          events: [
            ...completed(assistant(1)),
            { type: 'message_start', message: assistant(2) },
            chunk('cancel-ready'),
          ],
          waitForAbort: true,
          contextUsage: { tokens: 300, contextWindow: windowSize },
        },
        { events: completed(assistant(3, { usage: { input: 8, output: 3 } })) },
      ],
    })
    try {
      const session = await run.open()
      const pending = prompt(run.agent, session.sessionId!)
      await run.agent.waitForText('cancel-ready')
      run.agent.acp.cancel(session.sessionId!)
      const result = await pending
      expect(result.stopReason).toBe('cancelled')
      expect(result._meta?.['opl/turnUsage']).toEqual({ version: 1, usage: normalized })
      expect(commands(run.home).filter((name) => name === 'prompt')).toHaveLength(1)
      const next = await prompt(run.agent, session.sessionId!)
      expect(next.stopReason).toBe('end_turn')
      expect(next._meta?.['opl/turnUsage']).toEqual({
        version: 1,
        usage: { inputTokens: 8, outputTokens: 3 },
      })
    } finally {
      await run.agent.dispose()
    }
  })

  it('preserves completed work in a settled provider failure through the real ACP error parser', async () => {
    const run = await start({
      turns: [
        {
          events: [
            ...completed(assistant(1)),
            ...completed(
              assistant(2, {
                usage: undefined,
                stopReason: 'error',
                errorMessage: '429 rate limit exceeded',
              }),
            ),
            { type: 'auto_retry_end', success: false, finalError: '429 rate limit exceeded' },
          ],
          contextUsage: { tokens: 222, contextWindow: windowSize },
        },
      ],
    })
    try {
      const session = await run.open()
      const error: unknown = await prompt(run.agent, session.sessionId!).catch(
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(HarnessRequestError)
      expect((error as HarnessRequestError).promptSettled).toBe(true)
      expect((error as HarnessRequestError).statistics).toEqual({
        usage: normalized,
        contextUsage: { used: 222, size: windowSize, estimated: true },
      })
      expect(commands(run.home).filter((name) => name === 'prompt')).toHaveLength(1)
    } finally {
      await run.agent.dispose()
    }
  })

  it.each(['rejected', 'silent'] as const)(
    'returns a successful response when optional statistics are %s',
    async (statsFailure) => {
      const run = await start({ turns: [{ events: completed(assistant(1)), statsFailure }] })
      try {
        const session = await run.open()
        const result = await prompt(run.agent, session.sessionId!)
        expect(result.stopReason).toBe('end_turn')
        expect(result._meta?.['opl/turnUsage']).toEqual({ version: 1, usage: normalized })
        expect(result._meta?.['opl/contextUsage']).toEqual({ size: windowSize, estimated: true })
        expect(commands(run.home).filter((name) => name === 'prompt')).toHaveLength(1)
      } finally {
        await run.agent.dispose()
      }
    },
  )

  it.each([undefined, { ...usage, output: -1 }])(
    'withholds unknown or malformed final usage instead of substituting session totals',
    async (badUsage) => {
      const run = await start({ turns: [{ events: completed(assistant(1, { usage: badUsage })) }] })
      try {
        const session = await run.open()
        const result = await prompt(run.agent, session.sessionId!)
        expect(result.stopReason).toBe('end_turn')
        expect(result._meta?.['opl/turnUsage']).toBeUndefined()
      } finally {
        await run.agent.dispose()
      }
    },
  )

  it('releases prompt ownership after rejection so the next accepted turn can report usage', async () => {
    const run = await start({ turns: [{ rejected: true }, { events: completed(assistant(1)) }] })
    try {
      const session = await run.open()
      await expect(prompt(run.agent, session.sessionId!)).rejects.toThrow()
      const result = await prompt(run.agent, session.sessionId!)
      expect(result._meta?.['opl/turnUsage']).toEqual({ version: 1, usage: normalized })
      expect(commands(run.home).filter((name) => name === 'prompt')).toHaveLength(2)
    } finally {
      await run.agent.dispose()
    }
  })
})
