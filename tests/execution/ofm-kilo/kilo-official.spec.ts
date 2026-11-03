/**
 * Live surface evidence from the official pinned Kilo CLI (`@kilocode/cli@7.8.8`).
 *
 * This spec talks to a **real** official `kilo.exe` over the suite's own ACP transport. It
 * exists because every capability decision in this adapter came from measuring that binary
 * rather than from documentation:
 *
 *   - `session/new` advertises `model`, `effort` and `mode`; only the route's own model is
 *     pin-able, and the ids this adapter declares survive the namespace unchanged.
 *   - `session/load` returns an advertisement on the CLI's own default model, so a restored
 *     session cannot be assumed to have kept its pinned model.
 *   - `session/cancel` answers `-32601 "Method not found"`, which is why the adapter declares
 *     `cancel: false`.
 *   - The advertised `effort` option offers no values for a route model and rejects every
 *     write, and no model advertises `max`, which is why no effort is ever sent.
 *   - A model outside the advertisement is refused with `-32602` and the session keeps its
 *     model, so a refused pin fails closed instead of drifting.
 *
 * No model is ever called: the route points at a closed loopback port and the spec stops
 * after session configuration, so there is no network traffic, no credential, and no
 * provider involved. The keyless loopback-provider probe that exercises the real bash tool
 * and the shell binding lives in the owned report directory instead.
 *
 * The binary is not vendored into this repository. Point `KILO_OFFICIAL_BINARY` at a
 * verified official install (or the pinned `@kilocode/cli-windows-x64` build); when it is
 * unset the whole suite skips rather than pretending to have run.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AcpProcess } from '../../../src/execution/host/acp.ts'
import {
  kiloProfileRoots,
  KILO_OFM_MODELS,
  KILO_MODEL_OPTION,
  kiloModelValue,
} from '../../../src/execution/host/adapters/kilo/index.ts'

const exec = promisify(execFile)
/** Set this to a verified official binary path to enable the suite. */
const BINARY = process.env.KILO_OFFICIAL_BINARY
const PINNED_VERSION = '7.8.8'
/** Closed loopback port: the CLI must load this route without reaching any provider. */
const KEYLESS_BASE_URL = 'http://127.0.0.1:9/v1'

interface Fixture {
  acp: AcpProcess
  dir: string
  cwd: string
}

let root = ''
let harness: Fixture
const booted: AcpProcess[] = []

beforeAll(async () => {
  if (!BINARY) return
  await access(BINARY)
  root = await mkdtemp(join(tmpdir(), 'opl-kilo-official-'))
  const profile = kiloProfileRoots(root)
  for (const dir of Object.values(profile)) await mkdir(dir, { recursive: true })
  // A Chinese-plus-space working directory: the launch vector must carry it verbatim.
  const cwd = join(root, '中文 项目 dir')
  await mkdir(cwd, { recursive: true })
  const acp = new AcpProcess(
    BINARY,
    ['acp', '--cwd', cwd],
    cwd,
    {
      ...process.env,
      PATH: process.env.PATH!,
      ...profile,
      // Isolated profile; no shared config roots, no updater, no user config files.
      KILO_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://kilo.ai/schema.json',
        provider: {
          oplkilo: {
            npm: '@ai-sdk/openai-compatible',
            name: 'OPL Route',
            // Loopback and keyless: this spec never reaches a model and never holds a
            // credential. The address only has to be well-formed for the CLI to load it.
            options: { baseURL: KEYLESS_BASE_URL, apiKey: 'probe-keyless' },
            models: Object.fromEntries(KILO_OFM_MODELS.map((m) => [m, { name: m }])),
          },
        },
      }),
      KILO_DISABLE_AUTOUPDATE: '1',
      KILO_DISABLE_MODELS_FETCH: '1',
    },
    () => {},
    () => {},
    () => {},
  )
  booted.push(acp)
  harness = { acp, dir: root, cwd }
}, 240_000)

afterAll(async () => {
  for (const acp of booted.splice(0)) await acp.dispose()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const modelOption = (result: Record<string, any>) =>
  ((result?.configOptions ?? []) as any[]).find((option: any) => option.id === KILO_MODEL_OPTION)

describe.skipIf(!BINARY)('官方 Kilo CLI 实测面', () => {
  it('报告的版本与 pin 版本一致', async () => {
    const result = await exec(BINARY!, ['--version'], {
      env: { ...process.env, ...kiloProfileRoots(root) },
      windowsHide: true,
    })
    expect(result.stdout.trim()).toBe(PINNED_VERSION)
  })

  it('initialize 广告 ACP v1、loadSession 与官方账号方式', async () => {
    const agent = (await harness.acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'opl-official-probe', version: '1.0.0' },
    })) as Record<string, any>
    expect(agent.protocolVersion).toBe(1)
    expect(agent.agentCapabilities.loadSession).toBe(true)
    expect(agent.agentInfo.name).toBe('Kilo')
    expect(agent.agentInfo.version).toBe(PINNED_VERSION)
    // 官方账号方式存在，但本适配不消费它：凭据来自模型来源。
    expect(agent.authMethods.map((m: any) => m.id)).toContain('kilo-login')
  })

  it('新会话广告 model/effort/mode，本路由模型逐字可选', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    const ids = (created.configOptions ?? []).map((o: any) => o.id).sort()
    expect(ids).toEqual(['effort', 'mode', 'model'])
    const model = modelOption(created)
    const offered = model.options.map((o: any) => o.value)
    // Slash- and colon-bearing ids survive the provider/model namespace unchanged.
    for (const id of KILO_OFM_MODELS) expect(offered).toContain(kiloModelValue(id))
    await harness.acp.request('session/close', { sessionId: created.sessionId })
  })

  it('固定模型后回读一致，每个声明 id 都能逐字选中', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    for (const id of KILO_OFM_MODELS) {
      const value = kiloModelValue(id)
      const written = (await harness.acp.request('session/set_config_option', {
        sessionId: created.sessionId,
        configId: KILO_MODEL_OPTION,
        value,
      })) as Record<string, any>
      expect(modelOption(written).currentValue).toBe(value)
    }
    await harness.acp.request('session/close', { sessionId: created.sessionId })
  })

  it('未广告的模型被拒绝，会话保留原模型，不静默替换', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    const pinned = kiloModelValue(KILO_OFM_MODELS[0])
    await harness.acp.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: KILO_MODEL_OPTION,
      value: pinned,
    })
    await expect(
      harness.acp.request('session/set_config_option', {
        sessionId: created.sessionId,
        configId: KILO_MODEL_OPTION,
        value: 'oplkilo/not-declared',
      }),
    ).rejects.toThrow()
    const back = (await harness.acp.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: KILO_MODEL_OPTION,
      value: pinned,
    })) as Record<string, any>
    expect(modelOption(back).currentValue).toBe(pinned)
    await harness.acp.request('session/close', { sessionId: created.sessionId })
  })

  it('session/load 不恢复已固定的模型，因此恢复后必须重新固定', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    const pinned = kiloModelValue(KILO_OFM_MODELS[0])
    await harness.acp.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: KILO_MODEL_OPTION,
      value: pinned,
    })
    const restored = (await harness.acp.request('session/load', {
      sessionId: created.sessionId,
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    expect(modelOption(restored).currentValue).not.toBe(pinned)
    const again = (await harness.acp.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: KILO_MODEL_OPTION,
      value: pinned,
    })) as Record<string, any>
    expect(modelOption(again).currentValue).toBe(pinned)
    await harness.acp.request('session/close', { sessionId: created.sessionId })
  })

  it('每个声明模型均无 effort 广告或可写档位', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    // 实测：CLI 自带默认模型下 effort 仍在广告里，但只有 thinking 一个值。
    const beforePin = (created.configOptions ?? []).find((o: any) => o.id === 'effort')
    expect(beforePin.options.map((o: any) => o.value)).toEqual(['thinking'])

    for (const id of KILO_OFM_MODELS) {
      const pinned = kiloModelValue(id)
      const written = (await harness.acp.request('session/set_config_option', {
        sessionId: created.sessionId,
        configId: KILO_MODEL_OPTION,
        value: pinned,
      })) as Record<string, any>
      expect(modelOption(written).currentValue).toBe(pinned)
      // 本路由模型没有 effort 配置项，只有 model 与 mode。
      expect((written.configOptions ?? []).map((o: any) => o.id).sort()).toEqual(['mode', 'model'])
      expect((written.configOptions ?? []).find((o: any) => o.id === 'effort')).toBeUndefined()
      for (const value of ['thinking', 'high', 'max']) {
        await expect(
          harness.acp.request('session/set_config_option', {
            sessionId: created.sessionId,
            configId: 'effort',
            value,
          }),
        ).rejects.toThrow()
      }
    }
    await harness.acp.request('session/close', { sessionId: created.sessionId })
  })

  it('session/cancel 未实现，适配器因此不广告取消', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    await expect(
      harness.acp.request('session/cancel', { sessionId: created.sessionId }),
    ).rejects.toThrow()
    await harness.acp.request('session/close', { sessionId: created.sessionId })
  })
})
