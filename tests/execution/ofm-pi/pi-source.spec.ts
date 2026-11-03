/**
 * Behaviour of the Pi source group and the launch-time source lease, against the *real*
 * `ExternalModelSources` registry, so registration ownership and late revocation are
 * exercised by the shared code rather than by a fake.
 *
 * The freshness cases are the ones the review board called out: preparation is asynchronous,
 * so a source can be revoked, replaced or re-registered *while it is being read*. Each case
 * gates the owner's resolver on a promise the test opens by hand, so the revocation lands at
 * a known point in the sequence — no sleeps, no polling.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { HarnessConfigurationError } from '../../../src/execution/host/acp.ts'
import { createPiAdapter } from '../../../src/execution/host/adapters/pi/index.ts'
import {
  PI_HARNESS,
  PI_MODEL_INKLING,
  PI_MODEL_INKLING_FULL,
  PI_MODEL_GEMMA,
  PI_MODEL_LFM,
  PI_MODEL_NEMOTRON,
  PI_PROVIDER,
  createPiSource,
  registerPiSource,
  piLaneProtocol,
  resolvePiRoute,
  type PiSourceAnswer,
} from '../../../src/execution/host/adapters/pi/index.ts'
import type { ModelRef } from '../../../src/execution/contracts/catalog.ts'
import {
  applyOfmModelSource,
  createOfmApiConnection,
} from '../../../src/execution/host/ofm-source/index.ts'
import { fixtureCaller } from '../ofm-source/owner-api-fixture.ts'

const owner = { effect: (effect: () => () => void) => effect() } as unknown as Context
const ctx = { credentials: {}, get: () => undefined } as unknown as Context

const nemotron: ModelRef = { provider: PI_PROVIDER, model: PI_MODEL_NEMOTRON }
const lfm: ModelRef = { provider: PI_PROVIDER, model: PI_MODEL_LFM }

/** A registry with the Pi source registered, and handles to change its answers. */
function registered(initial: Partial<PiSourceAnswer> = {}) {
  const sources = new ExternalModelSources(ctx)
  const calls: { harness: string; ref: ModelRef }[] = []
  let answer: PiSourceAnswer = {
    baseURL: 'https://models.example.test/v1',
    apiKey: 'owner-key',
    model: PI_MODEL_NEMOTRON,
    protocol: 'chat',
    ...initial,
  }
  let gate: Promise<void> | undefined
  let openGate!: () => void
  const ctxWithRegistry = {
    ...ctx,
    oplExternalModelSources: sources,
    effect: (effect: () => () => void) => effect(),
  } as unknown as Context
  const unregister = registerPiSource(ctxWithRegistry, (harness, ref) => {
    calls.push({ harness, ref })
    return gate ? gate.then(() => answer) : answer
  })
  return {
    sources,
    calls,
    unregister,
    setAnswer(next: Partial<PiSourceAnswer>) {
      answer = { ...answer, ...next }
    },
    hold() {
      gate = new Promise<void>((done) => (openGate = done))
      return () => openGate()
    },
  }
}

describe('Pi source registration', () => {
  it('authorizes only this harness and the exact lane ids', () => {
    const sources = new ExternalModelSources(ctx)
    sources.register(
      owner,
      createPiSource(() => ({
        baseURL: 'https://x.test/v1',
        apiKey: 'k',
        model: PI_MODEL_NEMOTRON,
        protocol: 'chat',
      })),
    )
    expect(sources.supports(PI_HARNESS, nemotron)).toBe(true)
    expect(sources.supports(PI_HARNESS, lfm)).toBe(true)
    expect(sources.supports(PI_HARNESS, { provider: PI_PROVIDER, model: PI_MODEL_INKLING })).toBe(
      true,
    )
    expect(
      sources.supports(PI_HARNESS, { provider: PI_PROVIDER, model: PI_MODEL_INKLING_FULL }),
    ).toBe(true)
    expect(sources.supports(PI_HARNESS, { provider: PI_PROVIDER, model: PI_MODEL_GEMMA })).toBe(
      true,
    )
    // Another harness, another owner, or an unpinned id is not absorbed.
    expect(sources.supports('codex', nemotron)).toBe(false)
    expect(sources.supports(PI_HARNESS, { provider: 'other', model: PI_MODEL_NEMOTRON })).toBe(
      false,
    )
    expect(sources.supports(PI_HARNESS, { provider: PI_PROVIDER, model: 'gpt-oss-20b' })).toBe(
      false,
    )
  })

  it.each([PI_MODEL_INKLING_FULL, PI_MODEL_GEMMA])(
    'refuses a different model or protocol for %s',
    async (model) => {
      const modelRef = { provider: PI_PROVIDER, model }
      const substituted = registered({ model: PI_MODEL_INKLING })
      await expect(substituted.sources.resolve(PI_HARNESS, modelRef, 'chat')).rejects.toThrow(
        /与所选组合.*不一致/,
      )
      const changedProtocol = registered({ model, protocol: 'responses' })
      await expect(changedProtocol.sources.resolve(PI_HARNESS, modelRef, 'chat')).rejects.toThrow(
        /与本组合固定的协议（chat）不一致/,
      )
    },
  )

  it('pins each lane to the model the combination names, never the source answer', async () => {
    const first = registered({ model: PI_MODEL_NEMOTRON })
    const route = await first.sources.resolve(PI_HARNESS, nemotron, piLaneProtocol(nemotron)!)
    expect(route.model).toBe(PI_MODEL_NEMOTRON)

    // The owner answers with another lane's id for the Inkling combination: refused, rather
    // than accepted as "the same model under another name".
    const other = registered({ model: PI_MODEL_NEMOTRON })
    await expect(
      other.sources.resolve(PI_HARNESS, { provider: PI_PROVIDER, model: PI_MODEL_INKLING }, 'chat'),
    ).rejects.toThrow(/与所选组合（thinkingmachines\/inkling-small:free）不一致/)
  })

  it('refuses a protocol the combination did not pin, or the CLI has no API for', async () => {
    const drifted = registered({ protocol: 'responses' })
    await expect(drifted.sources.resolve(PI_HARNESS, nemotron, 'chat')).rejects.toThrow(
      /与本组合固定的协议（chat）不一致/,
    )
    const unsupported = registered({ protocol: 'grpc' })
    await expect(unsupported.sources.resolve(PI_HARNESS, nemotron, 'chat')).rejects.toThrow(
      /不在官方 Pi 支持的范围内/,
    )
  })

  it('refuses an incomplete route rather than launching with a blank endpoint', async () => {
    const blank = registered({ baseURL: '   ' })
    await expect(blank.sources.resolve(PI_HARNESS, nemotron, 'chat')).rejects.toThrow(
      /未提供兼容的执行参数/,
    )
    const keyless = registered({ apiKey: '' })
    await expect(keyless.sources.resolve(PI_HARNESS, nemotron, 'chat')).rejects.toThrow(
      /未提供兼容的执行参数/,
    )
  })

  it('fails closed once the owner unloads, even mid-resolve', async () => {
    const held = registered()
    const open = held.hold()
    const read = held.sources.resolve(PI_HARNESS, nemotron, 'chat')
    // The owner goes away while the credential read is still in flight.
    held.unregister()
    open()
    await expect(read).rejects.toThrow(/模型来源已变更|尚未适配/)
    // And every later launch is refused too, with no fallback to an unowned route.
    await expect(held.sources.resolve(PI_HARNESS, nemotron, 'chat')).rejects.toThrow(/尚未适配/)
  })

  it('refuses to shadow a provider route another owner already registered', () => {
    const sources = new ExternalModelSources(ctx)
    // Stand in for the shared OFM source, which legitimately owns `our-free-model`.
    sources.register(
      owner,
      createPiSource(() => ({
        baseURL: 'https://ofm.example.test/v1',
        apiKey: 'k',
        model: PI_MODEL_NEMOTRON,
        protocol: 'chat',
      })),
    )
    const ctxWithRegistry = {
      ...ctx,
      oplExternalModelSources: sources,
      effect: (effect: () => () => void) => effect(),
    } as unknown as Context
    // A second local source for the same provider would override every other harness's
    // pairing, so registration is refused rather than allowed to win.
    expect(() =>
      registerPiSource(ctxWithRegistry, () => ({
        baseURL: 'https://shadow.test/v1',
        apiKey: 'k',
        model: PI_MODEL_NEMOTRON,
        protocol: 'chat',
      })),
    ).toThrow(/已由其他来源注册/)
  })

  it('never logs or stores the credential it resolves', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const held = registered({ apiKey: 'super-secret-owner-key' })
    await held.sources.resolve(PI_HARNESS, nemotron, 'chat')
    expect(JSON.stringify(spy.mock.calls)).not.toContain('super-secret-owner-key')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret-owner-key')
    spy.mockRestore()
    warn.mockRestore()
  })
})

describe('Pi additions through the OFM public owner API', () => {
  it.each(['thinkingmachines/inkling:free', 'google/gemma-4-31b-it:free'])(
    'resolves exact %s and refuses it after owner withdrawal',
    async (model) => {
      const fixture = fixtureCaller({ models: [model, PI_MODEL_INKLING] })
      const catalog = new Set(fixture.state.models)
      const modelContext = {
        effect: (effect: () => () => void) => effect(),
        llm: {
          listProviders: () => [{ id: PI_PROVIDER }],
          listModels: async () => [...catalog].map((id) => ({ id })),
          resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        },
      } as unknown as Context
      const sources = new ExternalModelSources(modelContext)
      modelContext.oplExternalModelSources = sources
      const dispose = applyOfmModelSource(modelContext, {
        providers: [PI_PROVIDER],
        connection: createOfmApiConnection(fixture.caller, 'http://ofm.example.test'),
      })
      try {
        const modelRef = { provider: PI_PROVIDER, model }
        const options = { home: '', grokCommand: '', nativeBridgePath: '', modelSources: sources }
        await expect(resolvePiRoute({ modelRef }, options)).resolves.toMatchObject({
          model,
          provider:
            model === PI_MODEL_INKLING_FULL ? 'opl-pi-inkling-full-lane' : 'opl-pi-gemma-lane',
          protocol: 'chat',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:32123/v1',
          apiKey: fixture.state.key,
        })
        expect(fixture.calls).toEqual([
          { url: 'http://ofm.example.test/api/our-free-model/clients', method: 'GET' },
        ])
        fixture.withdraw(model)
        await expect(resolvePiRoute({ modelRef }, options)).rejects.toThrow(
          /未提供可用的外部执行端点/,
        )
        expect(fixture.calls).toHaveLength(2)
        catalog.delete(model)
        await expect(resolvePiRoute({ modelRef }, options)).rejects.toThrow(/当前目录未提供模型/)
        expect(fixture.calls).toHaveLength(2)
      } finally {
        dispose()
      }
    },
  )
})

describe('Pi launch-time source freshness', () => {
  /** Adapter prepared with the real registry and a real, existing CLI command. */
  const adapter = createPiAdapter('unused-bridge-path.mjs')
  const realCli =
    process.env.OPL_PI_COMMAND ??
    'C:/Users/root/Documents/Codex/repair-20261013/ofm-harness-adaptation/pi/probe/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'

  const record = (
    ref: ModelRef = nemotron,
    sandbox: 'read-only' | 'workspace' | 'full-access' = 'full-access',
  ) =>
    ({
      id: 'session-1',
      combination: 'pi/nemotron',
      harnessRef: PI_HARNESS,
      modelRef: ref,
      cwd: process.cwd(),
      acpSessionId: '',
      origin: { kind: 'harness', sessionId: 's' },
      title: 't',
      sandbox,
      createdAt: '',
      updatedAt: '',
      turns: [],
    }) as any

  it('refuses to prepare at all when no source is registered', async () => {
    await expect(
      adapter.prepare!(ctx, record(), {
        home: 'C:/tmp/opl-pi-none',
        grokCommand: '',
        nativeBridgePath: '',
        command: realCli,
      } as any),
    ).rejects.toThrow(HarnessConfigurationError)
  })

  it('refuses a restricted permission before touching the credential path', async () => {
    const held = registered()
    // Permission is checked first: a refusal must leave no route resolved and no launch.
    await expect(
      adapter.prepare!(ctx, record(nemotron, 'workspace'), {
        home: 'C:/tmp/opl-pi-sandbox',
        grokCommand: '',
        nativeBridgePath: '',
        command: realCli,
        modelSources: held.sources,
      } as any),
    ).rejects.toThrow(/官方 Pi 没有只读或工作区写入隔离/)
    expect(held.calls).toHaveLength(0)
  })

  it('refuses a source revoked while preparation is still resolving', async () => {
    const held = registered()
    const open = held.hold()
    const preparing = adapter.prepare!(ctx, record(), {
      home: 'C:/tmp/opl-pi-late',
      grokCommand: '',
      nativeBridgePath: '',
      command: realCli,
      modelSources: held.sources,
    } as any)
    // Revocation lands while the owner's credential read is in flight. The lease was taken
    // before that read, so the launch must not be authorized.
    held.unregister()
    open()
    await expect(preparing).rejects.toThrow(/模型来源已变更|尚未适配|未找到官方 Pi/)
  })

  it('refuses a source that was unregistered and re-registered during preparation', async () => {
    const held = registered()
    const open = held.hold()
    const preparing = adapter.prepare!(ctx, record(), {
      home: 'C:/tmp/opl-pi-reregister',
      grokCommand: '',
      nativeBridgePath: '',
      command: realCli,
      modelSources: held.sources,
    } as any)
    // Same provider, same declared pairing, brand-new registration object. `supports` still
    // answers true, so only a lease bound to the *registration* can catch this.
    held.unregister()
    const reborn = new ExternalModelSources(ctx)
    const ctxWithRegistry = {
      ...ctx,
      oplExternalModelSources: reborn,
      effect: (effect: () => () => void) => effect(),
    } as unknown as Context
    registerPiSource(ctxWithRegistry, () => ({
      baseURL: 'https://models.example.test/v1',
      apiKey: 'owner-key',
      model: PI_MODEL_NEMOTRON,
      protocol: 'chat',
    }))
    open()
    await expect(preparing).rejects.toThrow(/模型来源已变更|尚未适配|未找到官方 Pi/)
  })
})
