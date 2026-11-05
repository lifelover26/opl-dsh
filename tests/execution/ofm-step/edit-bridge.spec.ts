/** StepCode bridge edits use a separate RPC process and suite-owned storage, without model credentials. */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stepStorage } from '../../../src/execution/host/adapters/step/step-config.ts'
import { STEP_MODEL_FREE } from '../../../src/execution/host/adapters/step/step-models.ts'
import { startStepAgent, stepTempDir, stepTestCleanup, type StepAgent } from './fixtures/agent.ts'

vi.setConfig({ testTimeout: 30_000 })
const FIXTURE = fileURLToPath(new URL('./edit-rpc-fixture.mjs', import.meta.url))
const SOURCE_ID = 'source-step-identity'
const MODEL_PROVIDER = 'opl-step-free-lane'
const timestamp = '2026-11-04T00:00:00.000Z'

interface History {
  ok: true
  sessionId: string
  token: string
  boundaries: { id: string; text?: string }[]
  settledInputId?: string
}
interface Result {
  ok: true
  sessionId: string
  retained: { previousId: string; nextId: string }[]
  ephemeral?: boolean
}

function seed(cwd: string): object[] {
  const entry = (id: string, parentId: string | null, data: object) => ({
    id,
    parentId,
    timestamp,
    ...data,
  })
  const user = (text: string) => ({ role: 'user', content: text, timestamp: 1 })
  const assistant = (text: string, extra = {}) => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    ...extra,
  })
  return [
    { type: 'session', version: 3, id: SOURCE_ID, cwd, timestamp },
    entry('model', null, {
      type: 'model_change',
      provider: MODEL_PROVIDER,
      modelId: STEP_MODEL_FREE,
    }),
    entry('thinking', 'model', { type: 'thinking_level_change', thinkingLevel: 'low' }),
    entry('u1', 'thinking', { type: 'message', message: user('identical prompt') }),
    entry('tool-call', 'u1', {
      type: 'message',
      message: assistant('tool requested', {
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', name: 'bash', id: 'call-1', arguments: { command: 'fixture' } },
        ],
      }),
    }),
    entry('tool-result', 'tool-call', {
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'bash',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'EXACT RETAINED TOOL OUTPUT' }],
        isError: false,
      },
    }),
    entry('a1', 'tool-result', { type: 'message', message: assistant('first response') }),
    entry('compaction', 'a1', {
      type: 'compaction',
      summary: 'EXACT RETAINED COMPACTION',
      firstKeptEntryId: 'u1',
      tokensBefore: 100,
      details: { fixture: { retained: true } },
    }),
    entry('abandoned-user', 'compaction', { type: 'message', message: user('abandoned prompt') }),
    entry('abandoned-response', 'abandoned-user', {
      type: 'message',
      message: assistant('abandoned response'),
    }),
    entry('u2', 'compaction', { type: 'message', message: user('identical prompt') }),
    entry('a2', 'u2', { type: 'message', message: assistant('second response') }),
    entry('u3', 'a2', { type: 'message', message: user('tail prompt') }),
    entry('a3', 'u3', { type: 'message', message: assistant('tail response') }),
    entry('latest-thinking', 'a3', { type: 'thinking_level_change', thinkingLevel: 'high' }),
  ]
}

async function launch() {
  const home = stepTempDir('edit-中文 home-')
  const cwd = stepTempDir('edit-中文 workspace-')
  const storage = stepStorage(home)
  for (const path of Object.values(storage)) mkdirSync(path, { recursive: true })
  const scratch = join(home, 'tmp')
  mkdirSync(scratch, { recursive: true })
  const sourceFile = join(storage.sessionDir, 'source.jsonl')
  writeFileSync(
    sourceFile,
    seed(cwd)
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )
  writeFileSync(
    join(storage.sessionIndexDir, `${SOURCE_ID}.json`),
    JSON.stringify({ sessionFile: sourceFile }),
  )
  const env = {
    PATH: process.env.PATH ?? '',
    TEMP: scratch,
    TMP: scratch,
    OPL_STEP_COMMAND: process.execPath,
    OPL_STEP_PREFIX: JSON.stringify([FIXTURE]),
    OPL_STEP_AGENT_DIR: storage.agentDir,
    OPL_STEP_CONFIG_ROOT: storage.configRoot,
    OPL_STEP_SESSION_DIR: storage.sessionDir,
    OPL_STEP_SESSION_INDEX_DIR: storage.sessionIndexDir,
    OPL_STEP_PROVIDER: MODEL_PROVIDER,
    OPL_STEP_MODEL: STEP_MODEL_FREE,
    OPL_STEP_BASE_URL: 'http://127.0.0.1:1/v1',
    OPL_STEP_API: 'openai-completions',
    OPL_STEP_REASONING: '1',
    OPL_STEP_THINKING: 'high',
    OPL_STEP_PRESET: '',
    STEPCODE_STORAGE_ROOT_DIR: storage.storageRoot,
  }
  const start = async () => {
    const agent = await startStepAgent({ cwd, env })
    await agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    return agent
  }
  const agent = await start()
  await agent.acp.request('session/load', { sessionId: SOURCE_ID, cwd, mcpServers: [] })
  return {
    agent,
    start,
    storage,
    sourceFile,
    cwd,
    knobs: (value: object) =>
      writeFileSync(join(storage.agentDir, 'edit-controls.json'), JSON.stringify(value)),
    commands: () =>
      readFileSync(join(storage.agentDir, 'edit-rpc-commands.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; entryId?: string }),
  }
}

const read = (agent: StepAgent, sessionId = SOURCE_ID) =>
  agent.acp.request('opl/edit/read', { sessionId }) as Promise<History>
const rewind = (agent: StepAgent, expected: History, targetId = 'u2') =>
  agent.acp.request('opl/edit/rewind', {
    sessionId: expected.sessionId,
    operationId: 'step-edit-operation',
    targetId,
    expectedToken: expected.token,
  }) as Promise<Result>

afterAll(stepTestCleanup)

describe('StepCode bridge message editing', () => {
  it('reports the exact native user event while a second replacement is still waiting for the model', async () => {
    const run = await launch()
    try {
      const source = readFileSync(run.sourceFile, 'utf8')
      const fork = await rewind(run.agent, await read(run.agent))
      run.knobs({ holdPrompt: true })
      const prompt = run.agent.acp.request('session/prompt', {
        sessionId: fork.sessionId,
        prompt: [{ type: 'text', text: 'identical prompt' }],
        _meta: { 'opl/clientRequestId': 'message-edit:second-replacement' },
      })
      await run.agent.waitForText('opl/stepInputId')
      const receipt = run.agent
        .all()
        .find(
          (value) =>
            (value as any).update?._meta?.['opl/clientRequestId'] ===
            'message-edit:second-replacement',
        ) as any
      expect(receipt.sessionId).toBe(fork.sessionId)
      const inputId = receipt.update._meta['opl/stepInputId'] as string
      expect(inputId).not.toBe('u1')
      expect(inputId).not.toBe('u2')
      const nativeFile = join(run.storage.sessionDir, `${fork.sessionId}.jsonl`)
      const native = readFileSync(nativeFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(native.find((entry) => entry.id === inputId)).toMatchObject({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'identical prompt' }] },
      })
      expect(await read(run.agent, fork.sessionId)).toEqual({ ok: false, code: 'busy' })
      await run.agent.acp.cancel(fork.sessionId)
      expect(await prompt).toMatchObject({ stopReason: 'cancelled', userMessageId: inputId })
      expect((await read(run.agent, fork.sessionId)).settledInputId).toBe(inputId)
      expect(readFileSync(run.sourceFile, 'utf8')).toBe(source)
      expect(run.commands().filter((call) => call.type === 'prompt')).toHaveLength(1)
    } finally {
      await run.agent.dispose()
    }
  })

  it.each([
    'inputTimestampMismatch',
    'inputTimestampMissing',
    'inputContentMismatch',
    'duplicateNewInput',
    'inputWrongParent',
    'changedPrefix',
    'rejectPrompt',
  ])('does not issue an input receipt for %s', async (flag) => {
    const run = await launch()
    try {
      run.knobs({ [flag]: true })
      const prompt = run.agent.acp.request('session/prompt', {
        sessionId: SOURCE_ID,
        prompt: [{ type: 'text', text: 'identical prompt' }],
        _meta: { 'opl/clientRequestId': 'message-edit:unverified' },
      })
      if (flag === 'rejectPrompt') await expect(prompt).rejects.toThrow()
      else await expect(prompt).resolves.not.toHaveProperty('userMessageId')
      expect(JSON.stringify(run.agent.all())).not.toContain('opl/stepInputId')
      expect(run.commands().filter((call) => call.type === 'prompt')).toHaveLength(1)
    } finally {
      await run.agent.dispose()
    }
  })

  it('reads only the active parent chain and detects a terminal reply behind configuration metadata', async () => {
    const run = await launch()
    try {
      const history = await read(run.agent)
      expect(history.boundaries).toEqual([
        { id: 'u1', text: 'identical prompt' },
        { id: 'u2', text: 'identical prompt' },
        { id: 'u3', text: 'tail prompt' },
      ])
      expect(history.settledInputId).toBe('u3')
      expect(history.token).toMatch(/^sha256:[a-f0-9]{64}$/)
    } finally {
      await run.agent.dispose()
    }
  })

  it('forks before the exact duplicate-text target, preserves tools and ids, restores effort, and loads after restart', async () => {
    const run = await launch()
    let second: StepAgent | undefined
    try {
      const source = readFileSync(run.sourceFile, 'utf8')
      const result = await rewind(run.agent, await read(run.agent))
      expect(result).toMatchObject({ ok: true, retained: [{ previousId: 'u1', nextId: 'u1' }] })
      expect(result.sessionId).not.toBe(SOURCE_ID)
      expect(result.ephemeral).toBeUndefined()
      expect((await read(run.agent, result.sessionId)).boundaries).toEqual([
        { id: 'u1', text: 'identical prompt' },
      ])
      const forkFile = join(run.storage.sessionDir, `${result.sessionId}.jsonl`)
      expect(readFileSync(forkFile, 'utf8')).toContain('EXACT RETAINED TOOL OUTPUT')
      expect(readFileSync(forkFile, 'utf8')).toContain('EXACT RETAINED COMPACTION')
      expect(readFileSync(run.sourceFile, 'utf8')).toBe(source)
      expect(run.commands().filter((call) => call.type === 'fork')).toEqual([
        expect.objectContaining({ entryId: 'u2' }),
      ])
      expect(run.commands().some((call) => call.type === 'prompt')).toBe(false)
      await run.agent.dispose()
      second = await run.start()
      const loaded = await second.acp.request('session/load', {
        sessionId: result.sessionId,
        cwd: run.cwd,
        mcpServers: [],
      })
      expect(loaded).toMatchObject({
        sessionId: result.sessionId,
        models: { currentModelId: STEP_MODEL_FREE },
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'thinking', currentValue: 'high' }),
        ]),
      })
      expect((await read(second, result.sessionId)).boundaries.map((entry) => entry.id)).toEqual([
        'u1',
      ])
    } finally {
      await run.agent.dispose()
      await second?.dispose()
    }
  })

  it('keeps a first-message fork ephemeral until a caller-owned prompt persists it, then loads its exact identity', async () => {
    const run = await launch()
    let second: StepAgent | undefined
    try {
      const source = readFileSync(run.sourceFile, 'utf8')
      const result = await rewind(run.agent, await read(run.agent), 'u1')
      expect(result).toMatchObject({ ok: true, retained: [], ephemeral: true })
      expect((await read(run.agent, result.sessionId)).boundaries).toEqual([])
      expect(existsSync(join(run.storage.sessionDir, `${result.sessionId}.jsonl`))).toBe(false)
      expect(existsSync(join(run.storage.sessionIndexDir, `${result.sessionId}.json`))).toBe(false)
      expect(run.commands().some((call) => call.type === 'prompt')).toBe(false)
      await run.agent.acp.request('session/prompt', {
        sessionId: result.sessionId,
        prompt: [{ type: 'text', text: 'caller-owned replacement' }],
      })
      expect(existsSync(join(run.storage.sessionIndexDir, `${result.sessionId}.json`))).toBe(true)
      expect(readFileSync(run.sourceFile, 'utf8')).toBe(source)
      await run.agent.dispose()
      second = await run.start()
      await second.acp.request('session/load', {
        sessionId: result.sessionId,
        cwd: run.cwd,
        mcpServers: [],
      })
      expect((await read(second, result.sessionId)).boundaries).toEqual([
        expect.objectContaining({ text: 'caller-owned replacement' }),
      ])
    } finally {
      await run.agent.dispose()
      await second?.dispose()
    }
  })

  it('invalidates the expected token when retained tool content changes before mutation', async () => {
    const run = await launch()
    try {
      const history = await read(run.agent)
      run.knobs({ changedTool: true })
      expect(await rewind(run.agent, history)).toEqual({ ok: false, code: 'history-changed' })
      expect(run.commands().some((call) => call.type === 'fork')).toBe(false)
    } finally {
      await run.agent.dispose()
    }
  })

  it('invalidates the expected token when the stored native file changes without a live entry change', async () => {
    const run = await launch()
    try {
      const history = await read(run.agent)
      writeFileSync(run.sourceFile, readFileSync(run.sourceFile, 'utf8') + '\n')
      expect(await rewind(run.agent, history)).toEqual({ ok: false, code: 'history-changed' })
      expect(run.commands().some((call) => call.type === 'fork')).toBe(false)
    } finally {
      await run.agent.dispose()
    }
  })

  it('refuses targets outside the active branch without mutation', async () => {
    const run = await launch()
    try {
      expect(await rewind(run.agent, await read(run.agent), 'abandoned-user')).toEqual({
        ok: false,
        code: 'target-unknown',
      })
      expect(run.commands().some((call) => call.type === 'fork')).toBe(false)
    } finally {
      await run.agent.dispose()
    }
  })

  it.each(['streaming', 'compacting', 'pending'])(
    'refuses official busy state: %s',
    async (flag) => {
      const run = await launch()
      try {
        run.knobs({ [flag]: true })
        expect(await read(run.agent)).toEqual({ ok: false, code: 'busy' })
        expect(run.commands().some((call) => call.type === 'fork')).toBe(false)
      } finally {
        await run.agent.dispose()
      }
    },
  )

  it.each(['duplicateId', 'orphan', 'cycle'])(
    'refuses malformed native entry graph: %s',
    async (flag) => {
      const run = await launch()
      try {
        run.knobs({ [flag]: true })
        expect(await read(run.agent)).toEqual({ ok: false, code: 'protocol' })
      } finally {
        await run.agent.dispose()
      }
    },
  )

  it.each(['forkReject', 'forkCancel'])(
    'verifies unchanged native history before reporting %s',
    async (flag) => {
      const run = await launch()
      try {
        const source = readFileSync(run.sourceFile, 'utf8')
        const history = await read(run.agent)
        run.knobs({ [flag]: true })
        expect(await rewind(run.agent, history)).toEqual({ ok: false, code: 'fork-rejected' })
        expect(readFileSync(run.sourceFile, 'utf8')).toBe(source)
        expect((await read(run.agent)).token).toBe(history.token)
        await expect(
          run.agent.acp.request('session/set_config_option', {
            sessionId: SOURCE_ID,
            configId: 'model',
            value: STEP_MODEL_FREE,
          }),
        ).resolves.toBeTruthy()
      } finally {
        await run.agent.dispose()
      }
    },
  )

  it.each([
    'keepTarget',
    'corruptTool',
    'corruptCompaction',
    'forkModelDrift',
    'noThinkingEcho',
    'noThinkingAfterFork',
    'rejectAfterMutation',
  ])('blocks subsequent sends on an unverifiable fork: %s', async (flag) => {
    const run = await launch()
    try {
      const history = await read(run.agent)
      run.knobs({ [flag]: true })
      expect(await rewind(run.agent, history)).toEqual({ ok: false, code: 'uncertain' })
      const forkFile = readdirSync(run.storage.sessionDir).find(
        (name) => name !== 'source.jsonl' && name.endsWith('.jsonl'),
      )!
      const id = JSON.parse(
        readFileSync(join(run.storage.sessionDir, forkFile), 'utf8').split('\n')[0]!,
      ).id
      await expect(
        run.agent.acp.request('session/prompt', {
          sessionId: id,
          prompt: [{ type: 'text', text: 'must not send' }],
        }),
      ).rejects.toThrow()
      await expect(
        run.agent.acp.request('session/set_config_option', {
          sessionId: id,
          configId: 'model',
          value: STEP_MODEL_FREE,
        }),
      ).rejects.toThrow()
      expect(run.commands().some((call) => call.type === 'prompt')).toBe(false)
    } finally {
      await run.agent.dispose()
    }
  })

  it('treats native exit during fork as uncertain and never sends a replacement', async () => {
    const run = await launch()
    try {
      const history = await read(run.agent)
      run.knobs({ forkExit: true })
      expect(await rewind(run.agent, history)).toEqual({ ok: false, code: 'uncertain' })
      expect(run.commands().some((call) => call.type === 'prompt')).toBe(false)
    } finally {
      await run.agent.dispose()
    }
  })

  it('refuses prompt, read, and configuration overlap while the official fork is pending', async () => {
    const run = await launch()
    try {
      const history = await read(run.agent)
      run.knobs({ holdFork: true })
      const started = join(run.storage.agentDir, 'edit-fork-started')
      const ready = new Promise<void>((resolve) => {
        const watcher = watch(run.storage.agentDir, () => {
          if (existsSync(started)) {
            watcher.close()
            resolve()
          }
        })
      })
      const fork = rewind(run.agent, history)
      await ready
      expect(await read(run.agent)).toEqual({ ok: false, code: 'busy' })
      await expect(
        run.agent.acp.request('session/prompt', {
          sessionId: SOURCE_ID,
          prompt: [{ type: 'text', text: 'must not queue' }],
        }),
      ).rejects.toThrow()
      await expect(
        run.agent.acp.request('session/set_config_option', {
          sessionId: SOURCE_ID,
          configId: 'model',
          value: STEP_MODEL_FREE,
        }),
      ).rejects.toThrow()
      writeFileSync(join(run.storage.agentDir, 'edit-fork-release'), 'continue')
      expect(await fork).toMatchObject({ ok: true })
      expect(run.commands().some((call) => call.type === 'prompt')).toBe(false)
    } finally {
      await run.agent.dispose()
    }
  })
})
