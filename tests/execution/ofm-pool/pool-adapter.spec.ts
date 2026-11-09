/**
 * Launch contract: what the adapter hands to the official CLI, and what it
 * refuses before anything starts.
 *
 * The refusal tests run without the official binary, so they execute on any host.
 * The argument-vector and environment tests need one and are gated on
 * `OPL_POOL_TEST_BIN` pointing at an official `pool` executable; without it they
 * skip rather than pretend.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import {
  POOL_HOOK_COMMAND_NAME,
  POOL_LAGUNA_S,
  POOL_LAGUNA_XS,
  POOL_SETTINGS_FILE,
  POOL_SHELL_ARGS_VARIABLE,
  POOL_SHELL_AUDIT_VARIABLE,
  POOL_SHELL_VARIABLE,
  poolAdapter,
} from '../../../src/execution/host/adapters/pool/index.ts'
import {
  ctx,
  owner,
  poolRecord,
  poolRef,
  poolSource,
  poolSources,
  route,
  scratchRoot,
} from './fixtures/records.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../../src/execution/host/contracts/sessions.ts'

const BIN = process.env.OPL_POOL_TEST_BIN
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

async function suiteHome(): Promise<string> {
  const dir = await mkdtemp(join(scratchRoot(), 'opl-pool-adapter-'))
  homes.push(dir)
  return dir
}

const options = (over: Partial<AdapterOptions> = {}): AdapterOptions =>
  ({
    home: join(scratchRoot(), 'opl-pool-suite'),
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
    ...(BIN ? { command: BIN } : {}),
    ...over,
  }) as AdapterOptions

const record = (over: Partial<HarnessSession> = {}) => poolRecord(over)

describe('pool adapter identity', () => {
  it('advertises only the interfaces this host verified', () => {
    expect(poolAdapter.capabilities).toEqual({
      transport: 'acp',
      authentication: 'api-source',
      protocols: ['chat'],
      customEndpoint: true,
      // The official boundary is a Docker sandbox whose tools run inside the
      // container, so no restricted tier is advertised.
      permissions: ['full-access'],
      sessionLoad: true,
      cancel: true,
      reasoning: 'cli-advertised',
      autoReview: 'unsupported',
    })
    expect(poolAdapter.transport).toBe('acp')
    expect(poolAdapter.id).toBe('pool')
  })

  it('claims no isolation for full access', async () => {
    const { poolPermissionPlan } =
      await import('../../../src/execution/host/adapters/pool/pool-permissions.ts')
    expect(poolPermissionPlan('full-access')).toEqual({
      mode: 'always-allow',
      sandbox: 'disabled',
      isolation: 'none',
    })
  })

  it('matches only the ids this host is prepared to pin', () => {
    expect(poolAdapter.matches(poolRef(POOL_LAGUNA_S))).toBe(true)
    expect(poolAdapter.matches(poolRef(POOL_LAGUNA_XS))).toBe(true)
    expect(poolAdapter.matches(poolRef('poolside/laguna-s-2.1'))).toBe(false)
    expect(poolAdapter.matches({ provider: 'somebody-else', model: POOL_LAGUNA_S })).toBe(false)
  })
})

describe('pool permission tiers', () => {
  it('refuses the restricted tiers instead of widening them', async () => {
    for (const tier of ['read-only', 'workspace'] as const) {
      await expect(poolAdapter.prepare!(ctx, record({ sandbox: tier }), options())).rejects.toThrow(
        /未把受限档位扩大为完整访问/u,
      )
    }
  })

  it('refuses an unknown tier without starting anything', async () => {
    await expect(
      poolAdapter.prepare!(ctx, record({ sandbox: 'whatever' as never }), options()),
    ).rejects.toThrow(/不支持的权限档位/u)
  })
})

describe('pool source authorization', () => {
  it('refuses before any launch when no source registry is wired', async () => {
    await expect(
      poolAdapter.prepare!(ctx, record(), options({ modelSources: undefined })),
    ).rejects.toThrow(/尚未注册到执行引擎/u)
  })

  it('refuses a model no registered source supports', async () => {
    const sources = poolSources(poolSource(route({ model: 'poolside/other' })))
    await expect(
      poolAdapter.prepare!(ctx, record(), options({ modelSources: sources })),
    ).rejects.toThrow(/尚未适配此 Harness/u)
  })

  it('refuses a source that answers with a different model', async () => {
    // A source that claims the pairing but resolves another id: the adapter itself has
    // to catch that, because the registry only validates the route shape.
    const sources = poolSources({
      provider: 'our-free-model',
      supports: () => true,
      resolve: async () => route({ model: POOL_LAGUNA_XS }),
    })
    await expect(
      poolAdapter.prepare!(ctx, record(), options({ modelSources: sources })),
    ).rejects.toThrow(/与所选组合不一致/u)
  })

  it('refuses a source that resolved under a different protocol', async () => {
    const sources = poolSources(poolSource(route({ protocol: 'messages' as never })))
    await expect(
      poolAdapter.prepare!(ctx, record(), options({ modelSources: sources })),
    ).rejects.toThrow(/模型来源未提供兼容的执行参数/u)
  })

  it('refuses when the source is withdrawn while the launch is being prepared', async () => {
    const sources = new ExternalModelSources(ctx)
    const dispose = sources.register(owner, {
      provider: 'our-free-model',
      supports: () => true,
      // The withdrawal lands while this await is in flight.
      resolve: async () => {
        dispose()
        return route()
      },
    })
    await expect(
      poolAdapter.prepare!(ctx, record(), options({ modelSources: sources })),
    ).rejects.toThrow(/模型来源已变更/u)
  })

  it('refuses a route whose base URL is not a usable endpoint', async () => {
    const sources = poolSources(poolSource(route({ baseURL: 'file:///etc/passwd' })))
    await expect(
      poolAdapter.prepare!(ctx, record(), options({ modelSources: sources })),
    ).rejects.toThrow(/模型来源未提供兼容的执行参数/u)
  })

  it('refuses a model id this harness does not own, even from its own provider', async () => {
    await expect(
      poolAdapter.prepare!(
        ctx,
        record({ modelRef: poolRef('poolside/laguna-s-2.1') }),
        options({
          modelSources: poolSources(poolSource(route({ model: 'poolside/laguna-s-2.1' }))),
        }),
      ),
    ).rejects.toThrow(/不属于官方 pool 可固定的组合/u)
  })
})

describe.skipIf(!BIN)('pool launch vector with the official binary', () => {
  const launch = async (
    over: Partial<HarnessSession> = {},
    overOptions: Partial<AdapterOptions> = {},
  ) => {
    const home = await suiteHome()
    const result = await poolAdapter.prepare!(
      ctx,
      record(over),
      options({ home, modelSources: poolSources(poolSource(route())), ...overOptions }),
    )
    return { home, result }
  }

  it('starts the ACP server with the settings file that carries the pin', async () => {
    const { home, result } = await launch()
    const settings = join(home, 'harnesses', 'pool', 'session-1', POOL_SETTINGS_FILE)
    expect(result.args).toEqual(['acp', '--sandbox', 'disabled', '--settings=' + settings])
    expect(result.command).toBe(BIN)
    expect(existsSync(settings)).toBe(true)
    const text = await readFile(settings, 'utf8')
    expect(text).toContain(`command: '${POOL_HOOK_COMMAND_NAME}'`)
    expect(text).toContain('matcher: shell')
  })

  it('passes the endpoint, credential and exact model through the launch environment', async () => {
    const { result } = await launch()
    expect(result.env.POOLSIDE_API_KEY).toBe('probe-key')
    expect(result.env.POOLSIDE_STANDALONE_BASE_URL).toBe('https://ofm.example.test/v1')
    expect(result.env.POOLSIDE_STANDALONE_MODEL).toBe(POOL_LAGUNA_S)
    // The pinned interpreter and its audit trail travel with the hooks.
    expect(result.env[POOL_SHELL_VARIABLE]).toMatch(/bash\.exe$/u)
    expect(JSON.parse(result.env[POOL_SHELL_ARGS_VARIABLE]!)).toEqual([
      '--noprofile',
      '--norc',
      '-c',
    ])
    expect(result.env[POOL_SHELL_AUDIT_VARIABLE]).toMatch(/shell-hook-audit\.ndjson$/u)
  })

  it('redirects the official Windows profile with the measured options only', async () => {
    const { home, result } = await launch()
    const sessionHome = join(home, 'harnesses', 'pool', 'session-1')
    // Measured on official pool 1.0.16: `USERPROFILE` plus `APPDATA` are enough for the
    // whole `poolside` tree to land under the suite-owned directory.
    expect(result.env.USERPROFILE).toBe(join(sessionHome, 'profile'))
    expect(result.env.APPDATA).toBe(join(sessionHome, 'profile', 'appdata'))
    // `LOCALAPPDATA` is inherited, not rewritten: the measured run showed the CLI
    // derives its local directory from `APPDATA`, so overriding it changes nothing.
    // `HOME` is never rewritten: moving it is not an officially supported knob on
    // Windows and is not repeated.
    expect(result.env.LOCALAPPDATA).toBe(process.env.LOCALAPPDATA)
    expect(result.env).not.toHaveProperty('XDG_CONFIG_HOME')
    expect(result.env).not.toHaveProperty('XDG_DATA_HOME')
    expect(result.env.HOME).toBe(process.env.HOME)
  })

  it('never carries the daily login state of the official CLI into the launch', async () => {
    const { result } = await launch({ id: 'session-2' })
    expect(result.env.USERPROFILE).not.toBe(process.env.USERPROFILE)
    expect(result.env.APPDATA).not.toBe(process.env.APPDATA)
  })

  it('writes the settings for each session separately', async () => {
    const first = await launch({ id: 'session-a' })
    const second = await launch({ id: 'session-b' })
    expect(first.result.args.at(-1)).not.toBe(second.result.args.at(-1))
    expect(existsSync(first.result.args.at(-1)!.slice('--settings='.length))).toBe(true)
    expect(existsSync(second.result.args.at(-1)!.slice('--settings='.length))).toBe(true)
  })
})
