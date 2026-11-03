/** Configure the compiled bridge against official Pi without submitting model prompts. */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { piStorage } from '../../../src/execution/host/adapters/pi/pi-config.ts'
import {
  PI_MODEL_GEMMA,
  PI_MODEL_INKLING_FULL,
  PI_PROVIDER,
  piLane,
  piLaneReasoning,
} from '../../../src/execution/host/adapters/pi/pi-models.ts'
import { piConfigOption } from '../../../src/execution/host/adapters/pi/pi.ts'
import { startControlledProvider, type ControlledProvider } from './fixtures/provider.ts'
import {
  PI_TEST_KEY,
  piTempDir,
  piTestCleanup,
  realPiCli,
  startPiAgent,
  type PiAgent,
} from './fixtures/agent.ts'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })
const cli = realPiCli()
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

interface ThinkingSession {
  agent: PiAgent
  provider: ControlledProvider
  sessionId: string
  configOptions: unknown
}

/** Keep the real CLI, loopback listener and profile inside this case's owned resources. */
async function withSession(
  model: string,
  run: (session: ThinkingSession) => Promise<void>,
): Promise<void> {
  const provider = await startControlledProvider('rate-limit')
  let agent: PiAgent | undefined
  try {
    const storage = piStorage(piTempDir('opl-pi-thinking-home-'))
    mkdirSync(storage.scratchDir, { recursive: true })
    const cwd = piTempDir('opl-pi-thinking-work-')
    agent = await startPiAgent({
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        OPL_PI_COMMAND: process.execPath,
        OPL_PI_PREFIX: JSON.stringify([cli!]),
        OPL_PI_AGENT_DIR: storage.agentDir,
        OPL_PI_SESSION_DIR: storage.sessionDir,
        OPL_PI_SESSION_INDEX_DIR: storage.sessionIndexDir,
        OPL_PI_PROVIDER: piLane({ provider: PI_PROVIDER, model })!.provider,
        OPL_PI_MODEL: model,
        OPL_PI_BASE_URL: provider.baseURL,
        OPL_PI_API: 'openai-completions',
        OPL_PI_REASONING: piLaneReasoning({ provider: PI_PROVIDER, model }) ? '1' : '0',
        OPL_PI_THINKING: '',
        OPL_PI_PERMISSION_TIER: 'full-access',
        OPL_PI_CREDENTIAL: PI_TEST_KEY,
        PI_CODING_AGENT_DIR: storage.agentDir,
        PI_CODING_AGENT_SESSION_DIR: storage.sessionDir,
        TEMP: storage.scratchDir,
        TMP: storage.scratchDir,
      },
    })
    await agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const result = object(await agent.acp.request('session/new', { cwd, mcpServers: [] }))
    const sessionId = result.sessionId
    if (typeof sessionId !== 'string' || !sessionId) throw Error('Pi 未返回会话 ID')
    await run({ agent, provider, sessionId, configOptions: result.configOptions })
  } finally {
    await agent?.dispose()
    await provider.close()
  }
}

const updates = (agent: PiAgent) =>
  agent
    .all()
    .filter((value) => object(object(value).update).sessionUpdate === 'config_option_update')

afterAll(() => piTestCleanup())

describe('Pi request-only thinking configuration', () => {
  it.runIf(cli)('changes live-advertised thinking after startup without a prompt', async () => {
    await withSession(
      PI_MODEL_INKLING_FULL,
      async ({ agent, provider, sessionId, configOptions }) => {
        const initial = piConfigOption(configOptions, 'thinking')!
        expect(initial.values).toContain('max')
        expect(initial.values).toContain('off')
        expect(updates(agent)).toHaveLength(0)
        let count = 0
        for (const value of ['max', 'off']) {
          const result = object(
            await agent.acp.request('session/set_config_option', {
              sessionId,
              configId: 'thinking',
              value,
            }),
          )
          expect(piConfigOption(result.configOptions, 'thinking')).toEqual({
            currentValue: value,
            values: initial.values,
          })
          expect(updates(agent)).toHaveLength(++count)
          expect(provider.requests).toHaveLength(0)
        }
      },
    )
  })

  it.runIf(cli)(
    'rejects unadvertised or malformed choices without changing live state',
    async () => {
      await withSession(
        PI_MODEL_INKLING_FULL,
        async ({ agent, provider, sessionId, configOptions }) => {
          expect(piConfigOption(configOptions, 'thinking')?.values).not.toContain('xhigh')
          const before = await agent.acp.request('opl/edit/read', { sessionId })
          expect(object(before).ok).toBe(true)
          for (const value of ['xhigh', 'balanced', '', undefined, null, ['low']]) {
            await expect(
              agent.acp.request('session/set_config_option', {
                sessionId,
                configId: 'thinking',
                value,
              }),
            ).rejects.toThrow('官方 Harness 拒绝了本次请求参数')
            expect(await agent.acp.request('opl/edit/read', { sessionId })).toEqual(before)
            expect(updates(agent)).toHaveLength(0)
            expect(provider.requests).toHaveLength(0)
          }
        },
      )
    },
  )

  it.runIf(cli)(
    'keeps Gemma without a thinking selector or configuration side effects',
    async () => {
      await withSession(PI_MODEL_GEMMA, async ({ agent, provider, sessionId, configOptions }) => {
        expect(piConfigOption(configOptions, 'thinking')).toBeUndefined()
        const before = await agent.acp.request('opl/edit/read', { sessionId })
        expect(object(before).ok).toBe(true)
        for (const value of ['off', 'disabled', 'high']) {
          await expect(
            agent.acp.request('session/set_config_option', {
              sessionId,
              configId: 'thinking',
              value,
            }),
          ).rejects.toThrow('官方 Harness 拒绝了本次请求参数')
          expect(await agent.acp.request('opl/edit/read', { sessionId })).toEqual(before)
          expect(updates(agent)).toHaveLength(0)
          expect(provider.requests).toHaveLength(0)
        }
      })
    },
  )
})
