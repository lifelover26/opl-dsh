/**
 * End-to-end behaviour of the ACP projection over the official Pi Coding Agent RPC surface.
 *
 * These cases drive the **real compiled bridge as a separate process**, through the suite's
 * own `AcpProcess`, against the **genuine official `pi` 1.2.0 binary**, with the model
 * endpoint answered by a keyless controlled loopback server. Nothing here is a same-process
 * function call, and nothing polls on a timer: every wait is resolved by the awaited protocol
 * traffic itself, so there is no sleep-and-hope race.
 *
 * The working directory used throughout mixes non-ASCII characters and a space, and the
 * controlled endpoint makes the official agent run a genuine external `git` command through
 * the pinned Git Bash, so quoting, PATH and non-ASCII paths are exercised rather than
 * asserted.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import { piStorage } from '../../../src/execution/host/adapters/pi/pi-config.ts'
import {
  PI_MODEL_LFM,
  PI_MODEL_NEMOTRON,
  PI_MODEL_INKLING_FULL,
  PI_MODEL_GEMMA,
  PI_PROVIDER,
  piLane,
  piLaneReasoning,
} from '../../../src/execution/host/adapters/pi/pi-models.ts'
import { startControlledProvider, type ControlledProvider } from './fixtures/provider.ts'
import {
  PI_TEST_KEY,
  piTempDir,
  piTestCleanup,
  realPiCli,
  startPiAgent,
  type PiAgent,
} from './fixtures/agent.ts'

// Every case here launches real processes (a Node bridge, the official Pi CLI, a loopback
// provider and a Git Bash command), so the default per-test budget is too small. This
// raises it for this file only, rather than changing the shared test configuration.
vi.setConfig({ testTimeout: 90_000 })

const exec = promisify(execFile)
const realCli = realPiCli()

/** The verified Git Bash, or an empty string on hosts without one. */
function safeBash(): string {
  try {
    return resolveGitBashPath()
  } catch {
    return ''
  }
}

interface Launch {
  agent: PiAgent
  home: string
  cwd: string
  provider: ControlledProvider
  env: Record<string, string>
  /** Where the bridge wrote the credential-blind provider config. */
  agentDir: string
}

/**
 * Build the same launch environment `preparePiLaunch` produces, then start it.
 *
 * The official dedicated profile entry (`PI_CODING_AGENT_DIR`) and the session directory are
 * used; `HOME` is never repointed, so the signed-in user's real `~/.pi/agent` is untouched.
 */
async function launch(
  overrides: {
    model?: string
    provider?: string
    thinking?: string
    shell?: string
    baseURL?: string
    script?: 'tool-then-answer' | 'stall' | 'answer-only' | 'rate-limit'
    cwd?: string
    windowsShim?: boolean
  } = {},
): Promise<Launch> {
  const cli = realCli!
  const controlled = await startControlledProvider(overrides.script ?? 'tool-then-answer')
  const model = overrides.model ?? PI_MODEL_NEMOTRON
  const modelRef = { provider: PI_PROVIDER, model }
  const home = piTempDir('opl-pi-会话 home-')
  const storage = piStorage(home)
  mkdirSync(storage.agentDir, { recursive: true })
  mkdirSync(storage.sessionDir, { recursive: true })
  mkdirSync(storage.scratchDir, { recursive: true })
  const cwd = overrides.cwd ?? piTempDir('opl-pi-工作 目录-')
  mkdirSync(cwd, { recursive: true })
  // A real repository, so the agent's own tool call runs real `git` in this directory.
  await exec('git', ['init', '-q'], { cwd, windowsHide: true })
  const shim = join(home, 'official cli shim.cmd')
  if (overrides.windowsShim)
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    OPL_PI_COMMAND: overrides.windowsShim ? shim : process.execPath,
    OPL_PI_PREFIX: JSON.stringify(overrides.windowsShim ? [] : [cli]),
    OPL_PI_AGENT_DIR: storage.agentDir,
    OPL_PI_SESSION_DIR: storage.sessionDir,
    OPL_PI_SESSION_INDEX_DIR: storage.sessionIndexDir,
    OPL_PI_PROVIDER: overrides.provider ?? piLane(modelRef)!.provider,
    OPL_PI_MODEL: model,
    OPL_PI_BASE_URL: overrides.baseURL ?? controlled.baseURL,
    OPL_PI_API: 'openai-completions',
    OPL_PI_REASONING: piLaneReasoning(modelRef) ? '1' : '0',
    OPL_PI_THINKING: overrides.thinking ?? '',
    OPL_PI_PERMISSION_TIER: 'full-access',
    OPL_PI_SHELL_PATH: overrides.shell ?? safeBash(),
    OPL_PI_CREDENTIAL: PI_TEST_KEY,
    PI_CODING_AGENT_DIR: storage.agentDir,
    PI_CODING_AGENT_SESSION_DIR: storage.sessionDir,
    TEMP: storage.scratchDir,
    TMP: storage.scratchDir,
  }
  const agent = await startPiAgent({ cwd, env })
  return { agent, home, cwd, provider: controlled, env, agentDir: storage.agentDir }
}

afterAll(() => piTestCleanup())

describe('Pi added lane config over the official CLI', () => {
  it.runIf(realCli).each([
    { thinking: 'max', wire: 'max' },
    { thinking: 'off', wire: 'none' },
  ])(
    'runs exact Inkling with $thinking mapped through the official config',
    async ({ thinking, wire }) => {
      const run = await launch({ model: PI_MODEL_INKLING_FULL, thinking, script: 'answer-only' })
      try {
        await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        const session = (await run.agent.acp.request('session/new', {
          cwd: run.cwd,
          mcpServers: [],
        })) as any
        expect(session.models.currentModelId).toBe('thinkingmachines/inkling:free')
        const option = session.configOptions.find((entry: any) => entry.id === 'thinking')
        expect(option.options.map((entry: any) => entry.value)).toEqual([
          'off',
          'minimal',
          'low',
          'medium',
          'high',
          'max',
        ])
        expect(option.currentValue).toBe(thinking)
        const config = JSON.parse(readFileSync(join(run.agentDir, 'models.json'), 'utf8'))
        expect(Object.keys(config.providers)).toEqual(['opl-pi-inkling-full-lane'])
        expect(config.providers['opl-pi-inkling-full-lane']).toMatchObject({
          api: 'openai-completions',
          models: [
            { id: 'thinkingmachines/inkling:free', thinkingLevelMap: { off: 'none', max: 'max' } },
          ],
        })
        await run.agent.acp.request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Reply OK.' }],
        })
        expect(run.provider.requests).toEqual(['/v1/chat/completions'])
        expect(run.provider.payloads).toHaveLength(1)
        expect(run.provider.payloads[0]).toMatchObject({
          model: 'thinkingmachines/inkling:free',
          reasoning_effort: wire,
        })
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )

  it.runIf(realCli)(
    'keeps Gemma on its exact model without a thinking selector or wire override',
    async () => {
      const run = await launch({ model: PI_MODEL_GEMMA, script: 'answer-only' })
      try {
        await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        const session = (await run.agent.acp.request('session/new', {
          cwd: run.cwd,
          mcpServers: [],
        })) as any
        expect(session.models.currentModelId).toBe('google/gemma-4-31b-it:free')
        expect(session.configOptions.some((entry: any) => entry.id === 'thinking')).toBe(false)
        const config = JSON.parse(readFileSync(join(run.agentDir, 'models.json'), 'utf8'))
        expect(Object.keys(config.providers)).toEqual(['opl-pi-gemma-lane'])
        expect(config.providers['opl-pi-gemma-lane'].models).toEqual([
          { id: 'google/gemma-4-31b-it:free', name: 'google/gemma-4-31b-it:free' },
        ])
        await expect(
          run.agent.acp.request('session/set_config_option', {
            sessionId: session.sessionId,
            configId: 'thinking',
            value: 'off',
          }),
        ).rejects.toThrow(/官方 Harness 拒绝了本次请求参数/)
        expect(run.provider.requests).toHaveLength(0)
        await run.agent.acp.request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Reply OK.' }],
        })
        expect(run.provider.requests).toEqual(['/v1/chat/completions'])
        expect(run.provider.payloads).toHaveLength(1)
        expect(run.provider.payloads[0]?.model).toBe('google/gemma-4-31b-it:free')
        for (const field of [
          'reasoning',
          'reasoning_effort',
          'thinking',
          'enable_thinking',
          'chat_template_kwargs',
        ])
          expect(run.provider.payloads[0]).not.toHaveProperty(field)
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )

  it.runIf(realCli).each(['off', 'high'])(
    'refuses an explicit %s choice on Gemma before sending a prompt',
    async (thinking) => {
      const run = await launch({ model: PI_MODEL_GEMMA, thinking })
      try {
        await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        await expect(
          run.agent.acp.request('session/new', { cwd: run.cwd, mcpServers: [] }),
        ).rejects.toThrow(/官方 Harness 拒绝了本次请求参数/)
        expect(run.provider.requests).toHaveLength(0)
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )
})

describe('Pi bridge: initialization and pinning over the official CLI', () => {
  it.runIf(realCli)('reports the official exhausted retry as a provider failure', async () => {
    const run = await launch({ script: 'rate-limit' })
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as { sessionId: string }
      const failure = await run.agent.acp
        .request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Reply OK.' }],
        })
        .catch((error) => error)
      expect(String(failure)).toContain('官方渠道限流或配额已达上限')
      expect(failure.promptSettled).toBe(true)
      const history = (await run.agent.acp.request('opl/edit/read', {
        sessionId: session.sessionId,
      })) as any
      expect(history.ok).toBe(true)
      expect(history.settledInputId).toBe(history.boundaries[0].id)
      const fork = (await run.agent.acp.request('opl/edit/rewind', {
        sessionId: session.sessionId,
        operationId: 'edit-rate-limit',
        targetId: history.boundaries[0].id,
        expectedToken: history.token,
      })) as any
      expect(fork.ok).toBe(true)
      expect(fork.sessionId).not.toBe(session.sessionId)
      const pending = (await run.agent.acp.request('opl/edit/read', {
        sessionId: fork.sessionId,
      })) as any
      expect(pending.boundaries).toEqual([])
    } finally {
      await run.agent.dispose()
      await run.provider.close()
    }
  })
  it.runIf(process.platform === 'win32' && !!realCli)(
    'passes RPC arguments through a Windows CLI shim with spaces',
    async () => {
      const run = await launch({ windowsShim: true })
      try {
        await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        expect(
          await run.agent.acp.request('session/new', { cwd: run.cwd, mcpServers: [] }),
        ).toHaveProperty('sessionId')
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )
  it.runIf(realCli)(
    'initializes over ACP and pins the lane model read back from the official CLI',
    async () => {
      const run = await launch()
      try {
        const init = (await run.agent.acp.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })) as any
        expect(init.protocolVersion).toBe(1)
        // `loadSession` is advertised only because `switch_session` is really driven here.
        expect(init.agentCapabilities.loadSession).toBe(true)

        const session = (await run.agent.acp.request('session/new', {
          cwd: run.cwd,
          mcpServers: [],
        })) as any
        // The authoritative read-back the host compares against the combination's wire model.
        expect(session.models.currentModelId).toBe(PI_MODEL_NEMOTRON)
        expect(session.sessionId).toBeTruthy()
        const model = session.configOptions.find((o: any) => o.id === 'model')
        expect(model.currentValue).toBe(PI_MODEL_NEMOTRON)
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )

  it.runIf(realCli)(
    'writes a credential-blind provider config into the official agent directory',
    async () => {
      const run = await launch()
      try {
        await run.agent.acp.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
        await run.agent.acp.request('session/new', { cwd: run.cwd, mcpServers: [] })
        // Pi loads `models.json` from inside PI_CODING_AGENT_DIR; a file elsewhere is ignored.
        const models = JSON.parse(readFileSync(join(run.agentDir, 'models.json'), 'utf8'))
        const entry = models.providers['opl-pi-nemotron-lane']
        expect(entry.baseUrl).toBe(run.provider.baseURL)
        // The key is referenced through the official `$ENV_VAR` interpolation, never written.
        expect(entry.apiKey).toBe('$OPL_PI_CREDENTIAL')
        expect(readFileSync(join(run.agentDir, 'models.json'), 'utf8')).not.toContain(PI_TEST_KEY)
        // One `shellPath` serves both the model `bash` tool and the user's `!` commands.
        const settings = JSON.parse(readFileSync(join(run.agentDir, 'settings.json'), 'utf8'))
        expect(settings.shellPath).toBe(safeBash())
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )

  it.runIf(realCli)(
    'runs a real external git command in a CJK-and-space cwd through the pinned bash',
    async () => {
      const run = await launch()
      try {
        await run.agent.acp.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
        const session = (await run.agent.acp.request('session/new', {
          cwd: run.cwd,
          mcpServers: [],
        })) as any
        const prompt = run.agent.acp.request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '运行一次 git 探测' }],
        })
        // Resolved by the awaited tool_call_update frame, not by a sleep.
        await run.agent.waitForToolStatus('call_1', 'completed')
        const result = await prompt
        expect((result as any).stopReason).toBe('end_turn')
        // The tool really ran `git`, in this directory, under the verified shell.
        const tool = run.agent
          .all()
          .map((u) => JSON.stringify(u))
          .find((json) => json.includes('call_1') && json.includes('git version'))
        expect(tool).toBeTruthy()
        if (process.platform === 'win32') {
          expect(run.provider.systemMessages.join(' ')).toContain(
            'The bash tool runs Git for Windows Bash',
          )
          expect(run.provider.systemMessages.join(' ')).toContain('/dev/null instead of nul')
        }
        // The credential reached the official CLI and was used against the endpoint.
        expect(run.provider.authorizations.join(' ')).toContain(PI_TEST_KEY)
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )
})

describe('Pi bridge: refuses drift instead of adapting', () => {
  it.runIf(realCli)(
    'refuses a model swap that is not this combination, with no fallback',
    async () => {
      const run = await launch()
      try {
        await run.agent.acp.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
        const session = (await run.agent.acp.request('session/new', {
          cwd: run.cwd,
          mcpServers: [],
        })) as any
        // The bridge accepts exactly the pinned id and no other, so a caller cannot quietly
        // move a session onto a different model.
        await expect(
          run.agent.acp.request('session/set_config_option', {
            sessionId: session.sessionId,
            configId: 'model',
            value: PI_MODEL_LFM,
          }),
        ).rejects.toThrow(/官方 Harness 拒绝了本次请求参数/)
        // No fallback: the refused swap never reached the model endpoint, and the live session
        // still reports the pinned model.
        expect(run.provider.requests).toHaveLength(0)
        expect(session.models.currentModelId).toBe(PI_MODEL_NEMOTRON)
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )

  it.runIf(realCli)('refuses a reasoning tier the model never advertised', async () => {
    const run = await launch({ thinking: 'max' })
    try {
      await run.agent.acp.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      // A probe confirmed `set_thinking_level max` answers `success: true` against this model
      // and silently clamps to `high`, so only the pre-write advertisement check prevents a
      // lane that never advertised `max` from appearing to accept it.
      await expect(
        run.agent.acp.request('session/new', { cwd: run.cwd, mcpServers: [] }),
      ).rejects.toThrow(/官方 Harness 拒绝了本次请求参数/)
      expect(run.provider.requests).toHaveLength(0)
    } finally {
      await run.agent.dispose()
      await run.provider.close()
    }
  })

  it.runIf(realCli)('advertises only the tiers the pinned model really offers', async () => {
    const run = await launch()
    try {
      await run.agent.acp.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      const thinking = session.configOptions.find((o: any) => o.id === 'thinking')
      const values = thinking.options.map((o: any) => o.value)
      expect(values).toContain('high')
      // A `reasoning: true` row advertises the real vocabulary; `max` is never invented here.
      expect(values).not.toContain('max')
      // Whatever the CLI reports is one of the tiers it also offers, never a fiction.
      expect(values).toContain(thinking.currentValue)
    } finally {
      await run.agent.dispose()
      await run.provider.close()
    }
  })

  it.runIf(realCli)('refuses a config option the projection does not publish', async () => {
    const run = await launch()
    try {
      await run.agent.acp.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      // The host transport deliberately reflects only the JSON-RPC *code*, never the bridge's
      // own text, so a refusal is asserted by the mapped message it produces. `-32602` is
      // the host's "this combination's parameters were rejected" bucket.
      await expect(
        run.agent.acp.request('session/set_config_option', {
          sessionId: session.sessionId,
          configId: 'permission',
          value: 'read-only',
        }),
      ).rejects.toThrow(/官方 Harness 拒绝了本次请求参数/)
      await expect(
        run.agent.acp.request('session/set_config_option', {
          sessionId: session.sessionId,
          configId: 'nonexistent',
          value: 'x',
        }),
      ).rejects.toThrow(/官方 Harness 拒绝了本次请求参数/)
    } finally {
      await run.agent.dispose()
      await run.provider.close()
    }
  })
})

describe('Pi bridge: session identity and cancellation', () => {
  it.runIf(realCli)('refuses to load a session it has no suite-owned record for', async () => {
    const run = await launch()
    try {
      await run.agent.acp.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      await run.agent.acp.request('session/new', { cwd: run.cwd, mcpServers: [] })
      // Refused rather than resolved by scanning the session tree or matching a name.
      await expect(
        run.agent.acp.request('session/load', {
          sessionId: 'not-a-known-session',
          cwd: run.cwd,
          mcpServers: [],
        }),
      ).rejects.toThrow(/官方 Harness 拒绝了本次请求参数/)
    } finally {
      await run.agent.dispose()
      await run.provider.close()
    }
  })

  it.runIf(realCli)(
    'refuses to continue a recorded session whose history file is gone',
    async () => {
      const run = await launch({ script: 'answer-only' })
      try {
        await run.agent.acp.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
        const session = (await run.agent.acp.request('session/new', {
          cwd: run.cwd,
          mcpServers: [],
        })) as any
        const index = join(run.home, 'pi', 'session-index', `${session.sessionId}.json`)
        expect(existsSync(index)).toBe(true)
        // `switch_session` answers `success: true` for a missing path and silently continues on a
        // different, empty session, so a vanished history file is refused instead.
        rmSync(JSON.parse(readFileSync(index, 'utf8')).sessionFile, { force: true })
        await expect(
          run.agent.acp.request('session/load', {
            sessionId: session.sessionId,
            cwd: run.cwd,
            mcpServers: [],
          }),
        ).rejects.toThrow(/官方 Harness 拒绝了本次请求参数/)
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )

  it.runIf(realCli)(
    'resumes the recorded session and re-proves the identity from live state',
    async () => {
      const run = await launch({ script: 'answer-only' })
      try {
        await run.agent.acp.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
        const first = (await run.agent.acp.request('session/new', {
          cwd: run.cwd,
          mcpServers: [],
        })) as any
        const index = join(run.home, 'pi', 'session-index', `${first.sessionId}.json`)
        // The official product creates a session file lazily, so a real turn is what gives the
        // session durable history to resume.
        const prompt = run.agent.acp.request('session/prompt', {
          sessionId: first.sessionId,
          prompt: [{ type: 'text', text: '先写一点历史' }],
        })
        await run.provider.waitForRequest()
        expect((await prompt).stopReason).toBe('end_turn')
        expect(existsSync(index)).toBe(true)

        const loaded = (await run.agent.acp.request('session/load', {
          sessionId: first.sessionId,
          cwd: run.cwd,
          mcpServers: [],
        })) as any
        // `switch_session` reports success even for a path that does not exist, so identity is
        // re-read from live state rather than trusted from the response.
        expect(loaded.sessionId).toBe(first.sessionId)
        expect(loaded.models.currentModelId).toBe(PI_MODEL_NEMOTRON)
      } finally {
        await run.agent.dispose()
        await run.provider.close()
      }
    },
  )

  it.runIf(realCli)('cancels an open turn and does not leave a lingering session', async () => {
    const run = await launch({ script: 'stall' })
    try {
      await run.agent.acp.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      const prompt = run.agent.acp.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '停在一个不会结束的请求上' }],
      })
      // Dispatch the cancel on the awaited first request rather than racing a timer.
      await run.provider.waitForRequest()
      await run.agent.acp.request('session/cancel', { sessionId: session.sessionId })
      const result = await prompt
      expect((result as any).stopReason).toBe('cancelled')
    } finally {
      await run.agent.dispose()
      await run.provider.close()
    }
  })
})
