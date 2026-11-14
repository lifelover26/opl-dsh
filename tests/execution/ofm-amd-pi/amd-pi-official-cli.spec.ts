/**
 * The five `amd/…` lanes against the **real official Pi CLI**, over the suite's own ACP
 * transport, with a keyless controlled loopback provider.
 *
 * The declaration-level facts are covered by `./amd-pi-lanes.spec.ts`. This file proves
 * the one that only the genuine product can answer: that the official CLI, reading the
 * `models.json` this adapter writes for an AMD lane, advertises **no thinking selector**
 * for it — so no effort can be chosen, sent, or silently mapped onto `high`.
 *
 * **What this is not.** The provider here is a local stand-in and the credential is a
 * fixed non-secret string. Nothing in this file contacts the OFM EAC/AMD channel or any
 * upstream model, so a pass here is **not** evidence that the AMD route is reachable.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { piStorage } from '../../../src/execution/host/adapters/pi/pi-config.ts'
import {
  PI_AMD_MODELS,
  PI_PROVIDER,
  piLane,
  piLaneReasoning,
} from '../../../src/execution/host/adapters/pi/pi-models.ts'
import { piConfigOption } from '../../../src/execution/host/adapters/pi/pi.ts'
import { startControlledProvider, type ControlledProvider } from '../ofm-pi/fixtures/provider.ts'
import {
  PI_TEST_KEY,
  piTempDir,
  piTestCleanup,
  realPiCli,
  startPiAgent,
  type PiAgent,
} from '../ofm-pi/fixtures/agent.ts'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })
const cli = realPiCli()
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

interface AmdSession {
  agent: PiAgent
  provider: ControlledProvider
  sessionId: string
  configOptions: unknown
  /** The agent directory the bridge wrote its credential-blind `models.json` into. */
  agentDir: string
}

/** Start the real CLI on one AMD lane, with every artefact inside this task's root. */
async function withSession(
  model: string,
  run: (session: AmdSession) => Promise<void>,
): Promise<void> {
  const provider = await startControlledProvider('rate-limit')
  let agent: PiAgent | undefined
  try {
    const storage = piStorage(piTempDir('opl-amd-pi-home-'))
    mkdirSync(storage.scratchDir, { recursive: true })
    const cwd = piTempDir('opl-amd-pi-work-')
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
    await run({
      agent,
      provider,
      sessionId,
      configOptions: result.configOptions,
      agentDir: storage.agentDir,
    })
  } finally {
    await agent?.dispose()
    await provider.close()
  }
}

afterAll(() => piTestCleanup())

// Skipped rather than faked when the genuine official CLI is absent: a stub would turn
// "the official product advertises no thinking selector" into "a test double does".
describe.skipIf(!cli)('Pi AMD lanes on the real official CLI', () => {
  it.each(PI_AMD_MODELS)('advertises %s with no thinking selector', async (model) => {
    await withSession(model, async ({ agent, provider, sessionId, configOptions }) => {
      // The model option carries the exact id, prefix included.
      const modelOption = piConfigOption(configOptions, 'model')
      expect(modelOption?.values).toEqual([model])
      expect(modelOption?.currentValue).toBe(model)
      // No thinking selector is advertised at all for these lanes.
      expect(piConfigOption(configOptions, 'thinking')).toBeUndefined()
      // Writing one is refused rather than approximated.
      await expect(
        agent.acp.request('session/set_config_option', {
          sessionId,
          configId: 'thinking',
          value: 'high',
        }),
      ).rejects.toThrow('官方 Harness 拒绝了本次请求参数')
      // And nothing was ever sent to the provider.
      expect(provider.requests).toHaveLength(0)
    })
  })

  it.runIf(cli)('writes an AMD row with no reasoning flag and no effort mapping', async () => {
    const model = PI_AMD_MODELS[0]
    await withSession(model, async ({ agent, agentDir }) => {
      const written = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')) as {
        providers: Record<string, { api: string; models: { id: string; reasoning?: boolean }[] }>
      }
      const lane = piLane({ provider: PI_PROVIDER, model })!
      const entry = written.providers[lane.provider]
      expect(entry).toBeDefined()
      expect(entry!.api).toBe('openai-completions')
      expect(entry!.models).toEqual([{ id: model, name: model }])
      expect(entry!.models[0]!.reasoning).toBeUndefined()
      expect(agent).toBeDefined()
    })
  })
})
