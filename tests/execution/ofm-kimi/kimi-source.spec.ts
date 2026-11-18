import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { kimiCodeAdapter } from '../../../src/execution/host/adapters/kimi/kimi.ts'
import {
  KIMI_HARNESS,
  KIMI_PROTOCOL,
  KIMI_PROVIDER,
  KIMI_ROUTE_ENV,
  createKimiCodeSource,
} from '../../../src/execution/host/adapters/kimi/index.ts'
import { kimiPermissionPlan } from '../../../src/execution/host/adapters/kimi/kimi-permissions.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'
import type { ModelRef } from '../../../src/execution/contracts/catalog.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import { kimiRecord } from './fixtures/records.ts'

const owner = { effect: (effect: () => () => void) => effect() } as unknown as Context
const ctx = { credentials: { resolve: vi.fn() }, get: () => undefined } as unknown as Context

const ref = (model: string): ModelRef => ({ provider: KIMI_PROVIDER, model })
const answer = {
  baseURL: 'http://127.0.0.1:49152/v1',
  apiKey: 'dummy-test-key',
  model: 'moonshotai/kimi-k3',
  protocol: KIMI_PROTOCOL,
} as const

let home = ''
let stubBinary = ''

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'opl-kimi-home-'))
  stubBinary = join(home, 'kimi-stub.mjs')
  await writeFile(stubBinary, '// stub\n')
  // The registry only accepts a discovered command the platform can actually run: it checks
  // `X_OK` off Windows and `F_OK` on it. Without the execute bit the stub reads as "not
  // installed" on Linux, so these tests would fail at CLI discovery instead of exercising
  // the launch preparation they are about.
  await chmod(stubBinary, 0o755)
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

const options = (sources?: ExternalModelSources): AdapterOptions =>
  ({
    home,
    grokCommand: 'grok',
    nativeBridgePath: join(home, 'bridge.mjs'),
    command: stubBinary,
    ...(sources ? { modelSources: sources } : {}),
  }) as AdapterOptions

const record = (extra: Partial<HarnessSession> = {}): HarnessSession =>
  kimiRecord(ref('moonshotai/kimi-k3'), { sandbox: 'read-only', ...extra })

const withSource = (): ExternalModelSources => {
  const sources = new ExternalModelSources(ctx)
  sources.register(
    owner,
    createKimiCodeSource(() => answer),
  )
  return sources
}

describe('Kimi Code combination source helper', () => {
  it('passes the owner route through unchanged', async () => {
    const source = createKimiCodeSource(() => answer)
    expect(source.provider).toBe(KIMI_PROVIDER)
    const route = await source.resolve(KIMI_HARNESS, ref('moonshotai/kimi-k3'))
    // The same route, not a discarded or substituted one.
    expect(route).toEqual({
      baseURL: answer.baseURL,
      apiKey: answer.apiKey,
      model: answer.model,
      protocol: KIMI_PROTOCOL,
    })
  })

  it('authorizes only this harness and only the exact Kimi models', () => {
    const source = createKimiCodeSource(() => answer)
    expect(source.supports(KIMI_HARNESS, ref('moonshotai/kimi-k3'))).toBe(true)
    expect(source.supports(KIMI_HARNESS, ref('moonshotai/kimi-k2.6'))).toBe(true)
    expect(source.supports('codex', ref('moonshotai/kimi-k3'))).toBe(false)
    for (const model of ['z-ai/glm-5.3', 'openai/gpt-oss-120b'])
      expect(source.supports(KIMI_HARNESS, ref(model))).toBe(false)
    expect(source.supports(KIMI_HARNESS, { provider: 'other', model: 'moonshotai/kimi-k3' })).toBe(
      false,
    )
  })

  it('does not register an owner of its own', () => {
    // `our-free-model` has one owner; this module must not create a second.
    expect(Object.keys(createKimiCodeSource(() => answer))).toEqual([
      'provider',
      'supports',
      'resolve',
    ])
  })
})

describe('Kimi Code launch preparation', () => {
  it('hands the official CLI the OFM route through its documented environment', async () => {
    const launch = await kimiCodeAdapter.prepare!(ctx, record(), options(withSource()))
    expect(launch.env?.[KIMI_ROUTE_ENV.model]).toBe(answer.model)
    expect(launch.env?.[KIMI_ROUTE_ENV.baseUrl]).toBe(answer.baseURL)
    expect(launch.env?.[KIMI_ROUTE_ENV.apiKey]).toBe(answer.apiKey)
    // `messages` is served to the CLI as its anthropic provider type.
    expect(launch.env?.[KIMI_ROUTE_ENV.providerType]).toBe('anthropic')
    // Retry count belongs to the official CLI (or the channel's own configuration),
    // rather than being imposed by this adapter.
    expect(launch.env).not.toHaveProperty('KIMI_LOOP_MAX_ATTEMPTS_PER_STEP')
    // The suite's own runtime root, so no Moonshot account profile is read or written.
    expect(launch.env?.[KIMI_ROUTE_ENV.home]).toBe(home)
    expect(JSON.parse(launch.env.OPL_KIMI_ARGS!)).toEqual(['acp'])
    expect(launch.args[0]).toMatch(/kimi-error-bridge\.mjs$/)
    expect(launch.env.OPL_KIMI_COMMAND).toBe(stubBinary)
    expect(launch.command).toBe(process.execPath)
  })

  it('never asks the user to log in, and never carries a Moonshot credential', async () => {
    const launch = await kimiCodeAdapter.prepare!(ctx, record(), options(withSource()))
    for (const forbidden of ['KIMI_CODE_TOKEN', 'MOONSHOT_API_KEY', 'ANTHROPIC_API_KEY'])
      expect(launch.env).not.toHaveProperty(forbidden)
  })

  it('refuses to launch when no source group is registered', async () => {
    await expect(kimiCodeAdapter.prepare!(ctx, record(), options())).rejects.toThrow(
      /尚未注册到执行引擎/,
    )
  })

  it('refuses an unsupported permission tier before touching the source', async () => {
    const ownerFn = vi.fn(() => answer)
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, createKimiCodeSource(ownerFn))
    await expect(
      kimiCodeAdapter.prepare!(ctx, record({ sandbox: 'workspace' }), options(sources)),
    ).rejects.toThrow(/未提供可验证的工作区写入隔离/)
    expect(ownerFn).not.toHaveBeenCalled()
  })

  it('refuses a model from another provider before touching the source', async () => {
    const ownerFn = vi.fn(() => answer)
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, createKimiCodeSource(ownerFn))
    await expect(
      kimiCodeAdapter.prepare!(
        ctx,
        kimiRecord(ref('moonshotai/kimi-k3'), {
          modelRef: { provider: 'other-provider', model: 'moonshotai/kimi-k3' },
        }),
        options(sources),
      ),
    ).rejects.toThrow(/不属于官方 Kimi Code/)
    expect(ownerFn).not.toHaveBeenCalled()
  })

  it('refuses a source that redirects the combination to another model', async () => {
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, {
      provider: KIMI_PROVIDER,
      supports: () => true,
      resolve: async () => ({ ...answer, model: 'moonshotai/kimi-k2.6' }),
    })
    await expect(kimiCodeAdapter.prepare!(ctx, record(), options(sources))).rejects.toThrow(
      /模型来源解析出的模型与所选组合不一致/,
    )
  })

  it('refuses a source whose protocol the CLI cannot express', async () => {
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, {
      provider: KIMI_PROVIDER,
      supports: () => true,
      resolve: async () => ({ ...answer, protocol: 'chat' }) as never,
    })
    // `resolve` is called with the pinned protocol, so a mismatched source fails first.
    await expect(kimiCodeAdapter.prepare!(ctx, record(), options(sources))).rejects.toThrow()
  })

  it('refuses a launch whose source was unloaded while the route was resolving', async () => {
    const sources = new ExternalModelSources(ctx)
    let release!: (value: typeof answer) => void
    const pending = new Promise<typeof answer>((done) => {
      release = done
    })
    const remove = sources.register(owner, {
      provider: KIMI_PROVIDER,
      supports: () => true,
      resolve: () => pending,
    })
    const read = kimiCodeAdapter.prepare!(ctx, record(), options(sources))
    remove()
    release(answer)
    await expect(read).rejects.toThrow(/模型来源已变更|模型来源在启动前被替换或卸载/)
  })

  it('refuses a launch when the source route changes during the shell check', async () => {
    const sources = new ExternalModelSources(ctx)
    // A mutable route, so the test can swap it mid-launch.
    let current: { baseURL: string; apiKey: string; model: string; protocol: string } = {
      ...answer,
    }
    sources.register(owner, {
      provider: KIMI_PROVIDER,
      supports: () => true,
      resolve: async () => ({ ...current, protocol: KIMI_PROTOCOL }),
    })
    const read = kimiCodeAdapter.prepare!(ctx, record(), options(sources))
    // Swapped while the awaits between the first resolve and the launch are pending.
    current = { ...answer, baseURL: 'http://127.0.0.1:1/v1' }
    await expect(read).rejects.toThrow(/模型来源在启动前变更/)
  })

  it('rejects the request when the same source object is unregistered and re-registered', async () => {
    // Source object identity is preserved across this cycle, so a check that only compared
    // the object would accept it. The captured registration must be what is compared.
    const sources = new ExternalModelSources(ctx)
    const source = {
      provider: KIMI_PROVIDER,
      supports: () => true,
      resolve: async () => answer,
    }
    const remove = sources.register(owner, source)
    const rejected = kimiCodeAdapter.prepare!(ctx, record(), options(sources)).then(
      () => false,
      () => true,
    )
    remove()
    sources.register(owner, source)
    expect(await rejected).toBe(true)
  })

  it('refuses a model outside the exact allowset before touching the source', async () => {
    const ownerFn = vi.fn(() => answer)
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, createKimiCodeSource(ownerFn))
    for (const model of ['z-ai/glm-5.3', 'openai/gpt-oss-120b'])
      await expect(
        kimiCodeAdapter.prepare!(
          ctx,
          kimiRecord(ref(model), { sandbox: 'read-only' }),
          options(sources),
        ),
      ).rejects.toThrow(/不属于官方 Kimi Code/)
    expect(ownerFn).not.toHaveBeenCalled()
  })

  it('honours an installation prefix without losing the acp argument', async () => {
    const launch = await kimiCodeAdapter.prepare!(ctx, record(), {
      ...options(withSource()),
      prefix: ['--profile', 'suite'],
    })
    expect(JSON.parse(launch.env.OPL_KIMI_ARGS!)).toEqual(['--profile', 'suite', 'acp'])
  })
})

describe('Kimi Code permission mapping', () => {
  it('maps only the tiers that were measured against the official binary', () => {
    expect(kimiPermissionPlan('read-only')).toEqual({ mode: 'plan', isolation: 'read-only' })
    expect(kimiPermissionPlan('full-access')).toEqual({ mode: 'yolo', isolation: 'none' })
    expect(() => kimiPermissionPlan('workspace')).toThrow(/未提供可验证的工作区写入隔离/)
    for (const tier of ['auto', '', 'readOnly', 'FULL-ACCESS'])
      expect(() => kimiPermissionPlan(tier)).toThrow()
  })

  it('refuses a permission tier on the recovery path too', () => {
    expect(() =>
      kimiCodeAdapter.verifySession!(record({ sandbox: 'workspace' }), {
        agent: { agentInfo: { name: 'Kimi Code CLI', version: '2.1.1' } },
        session: { sessionId: 's' },
        configOptions: [],
      } as never),
    ).toThrow(/未提供可验证的工作区写入隔离/)
  })
})
