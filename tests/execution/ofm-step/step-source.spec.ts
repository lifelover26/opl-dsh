/**
 * Behaviour of the StepCode source group against the *real* `ExternalModelSources`
 * registry, so registration ownership and late revocation are exercised by the shared
 * code rather than by a fake.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import {
  STEP_HARNESS,
  STEP_MODEL_FREE,
  STEP_MODEL_KILO,
  STEP_PROVIDER,
  createStepCodeSource,
  registerStepCodeSource,
  stepLaneProtocol,
  type StepSourceAnswer,
} from '../../../src/execution/host/adapters/step/index.ts'
import type { ModelRef } from '../../../src/execution/contracts/catalog.ts'
import { resolveStepRoute } from '../../../src/execution/host/adapters/step/step.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'

const owner = { effect: (effect: () => () => void) => effect() } as unknown as Context
const ctx = { credentials: {}, get: () => undefined } as unknown as Context

const free: ModelRef = { provider: STEP_PROVIDER, model: STEP_MODEL_FREE }
const kilo: ModelRef = { provider: STEP_PROVIDER, model: STEP_MODEL_KILO }

/** A registry with the StepCode source registered, and a handle to change its answers. */
function registered(initial: Partial<StepSourceAnswer> = {}) {
  const sources = new ExternalModelSources(ctx)
  const calls: { harness: string; ref: ModelRef }[] = []
  let answer: StepSourceAnswer = {
    baseURL: 'https://models.example.test/v1',
    apiKey: 'owner-key',
    model: STEP_MODEL_FREE,
    protocol: 'chat',
    ...initial,
  }
  let gate: Promise<void> | undefined
  let openGate!: () => void
  const ctxWithRegistry = {
    ...ctx,
    oplExternalModelSources: sources,
    // Registration is bound to this context's effect scope, so unloading the owner is
    // what revokes the source.
    effect: (effect: () => () => void) => effect(),
  } as unknown as Context
  const unregister = registerStepCodeSource(ctxWithRegistry, (harness, ref) => {
    calls.push({ harness, ref })
    return gate ? gate.then(() => answer) : answer
  })
  return {
    sources,
    calls,
    unregister,
    setAnswer(next: Partial<StepSourceAnswer>) {
      answer = { ...answer, ...next }
    },
    hold() {
      gate = new Promise<void>((done) => (openGate = done))
      return () => openGate()
    },
  }
}

describe('StepCode source registration', () => {
  it('passes the source-configured context budget to the launch route without adding a default', async () => {
    const source = registered({ contextWindow: 262_144 })
    const options = { modelSources: source.sources } as AdapterOptions
    expect((await resolveStepRoute({ modelRef: free }, options)).contextWindow).toBe(262_144)
    options.modelSources = registered().sources
    expect(await resolveStepRoute({ modelRef: free }, options)).not.toHaveProperty('contextWindow')
  })

  it('authorizes only this harness and the exact lane ids', () => {
    const sources = new ExternalModelSources(ctx)
    sources.register(
      owner,
      createStepCodeSource(() => ({
        baseURL: 'https://x.test/v1',
        apiKey: 'k',
        model: STEP_MODEL_FREE,
        protocol: 'chat',
      })),
    )
    expect(sources.supports(STEP_HARNESS, free)).toBe(true)
    expect(sources.supports(STEP_HARNESS, kilo)).toBe(true)
    // Another harness, another owner, or an unpinned id is not absorbed.
    expect(sources.supports('codex', free)).toBe(false)
    expect(sources.supports(STEP_HARNESS, { provider: 'other', model: STEP_MODEL_FREE })).toBe(
      false,
    )
    expect(sources.supports(STEP_HARNESS, { provider: STEP_PROVIDER, model: 'gpt-oss-20b' })).toBe(
      false,
    )
  })

  it('pins each lane to the model the combination names, never the source answer', async () => {
    const { sources } = registered({ model: STEP_MODEL_FREE })
    const route = await sources.resolve(STEP_HARNESS, free, stepLaneProtocol(free)!)
    expect(route.model).toBe(STEP_MODEL_FREE)
    expect(route.protocol).toBe('chat')

    const other = registered({ model: STEP_MODEL_KILO })
    const kiloRoute = await other.sources.resolve(STEP_HARNESS, kilo, stepLaneProtocol(kilo)!)
    expect(kiloRoute.model).toBe(STEP_MODEL_KILO)
  })

  it('keeps the two lanes separate instead of reusing one lane route for the other', async () => {
    const owner2 = registered({ model: STEP_MODEL_FREE })
    // The owner answers with the other lane's id for the Kilo combination: refused,
    // rather than accepted as "the same model under another name".
    await expect(
      owner2.sources.resolve(STEP_HARNESS, kilo, stepLaneProtocol(kilo)!),
    ).rejects.toThrow(/与所选组合（stepfun\/step-5-preview-free）不一致/)
  })

  it('refuses a protocol the combination did not pin', async () => {
    const owner2 = registered({ protocol: 'responses' })
    await expect(owner2.sources.resolve(STEP_HARNESS, free, 'chat')).rejects.toThrow(
      /与本组合固定的协议（chat）不一致/,
    )
  })

  it('refuses a protocol the official CLI has no provider API for', async () => {
    const owner2 = registered({ protocol: 'grpc' })
    await expect(owner2.sources.resolve(STEP_HARNESS, free, 'chat')).rejects.toThrow(
      /不在官方 StepCode 支持的范围内/,
    )
  })

  it('refuses an incomplete route rather than launching with a blank endpoint', async () => {
    const blank = registered({ baseURL: '   ' })
    await expect(blank.sources.resolve(STEP_HARNESS, free, 'chat')).rejects.toThrow(
      /未提供兼容的执行参数/,
    )
    const keyless = registered({ apiKey: '' })
    await expect(keyless.sources.resolve(STEP_HARNESS, free, 'chat')).rejects.toThrow(
      /未提供兼容的执行参数/,
    )
  })

  it('fails closed once the owner unloads, even mid-resolve', async () => {
    const owner2 = registered()
    const open = owner2.hold()
    const read = owner2.sources.resolve(STEP_HARNESS, free, 'chat')
    // The owner goes away while the credential read is still in flight.
    owner2.unregister()
    open()
    await expect(read).rejects.toThrow(/模型来源已变更|尚未适配/)
    // And every later launch is refused too, with no fallback to an unowned route.
    await expect(owner2.sources.resolve(STEP_HARNESS, free, 'chat')).rejects.toThrow(/尚未适配/)
  })

  it('rejects a duplicate registration of the same provider', () => {
    const sources = new ExternalModelSources(ctx)
    const entry = createStepCodeSource(() => ({
      baseURL: 'https://x.test/v1',
      apiKey: 'k',
      model: STEP_MODEL_FREE,
      protocol: 'chat',
    }))
    sources.register(owner, entry)
    expect(() => sources.register(owner, entry)).toThrow('已注册')
  })

  it('never logs or stores the credential it resolves', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const owner2 = registered({ apiKey: 'super-secret-owner-key' })
    await owner2.sources.resolve(STEP_HARNESS, free, 'chat')
    expect(JSON.stringify(spy.mock.calls)).not.toContain('super-secret-owner-key')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret-owner-key')
    spy.mockRestore()
    warn.mockRestore()
  })
})
