import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Gateway from '../../src/gateway/host/index.ts'

const restore = vi.hoisted(() => ({ migrate: vi.fn(), reviewer: vi.fn() }))
vi.mock('../../src/gateway/host/model-settings.ts', () => ({
  migrateGatewayProtocolDefaults: restore.migrate,
  ensureAutoReviewProvider: restore.reviewer,
  syncGatewayModels: vi.fn(),
}))

const contexts: Context[] = []
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  restore.migrate.mockReset().mockResolvedValue(undefined)
  restore.reviewer.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Startup fixture forbids network')
    }),
  )
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

async function mount() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
  await ctx.plugin(LlmRuntime)
  const native = ctx.plugin(PiAi, {})
  await native
  ctx.provide('settings', {
    configure: () => () => {},
    describe: () =>
      native.ctx.fiber.state === 2
        ? [{ ns: 'llm-pi-ai', value: { providers: {} }, revision: 0 }]
        : [],
  })
  await ctx.plugin(Gateway, { baseURL: 'https://fixture.invalid/v1' })
  await nextTurn()
  return { ctx, native }
}

describe('Gateway startup restoration', () => {
  it('retries a failed migration after the official provider finishes restarting', async () => {
    restore.migrate.mockRejectedValueOnce(Error('Provider is restarting'))
    const { native } = await mount()
    expect(restore.migrate).toHaveBeenCalledTimes(1)
    expect(restore.reviewer).not.toHaveBeenCalled()

    await native.ctx.fiber.restart()
    await nextTurn()
    expect(restore.migrate).toHaveBeenCalledTimes(2)
    expect(restore.reviewer).toHaveBeenCalledTimes(1)

    await native.ctx.fiber.restart()
    await nextTurn()
    expect(restore.migrate).toHaveBeenCalledTimes(2)
  })

  it('retries a failed reviewer restore after a relevant settings revision', async () => {
    restore.reviewer.mockRejectedValueOnce(Error('Settings changed'))
    const { ctx } = await mount()
    expect(restore.reviewer).toHaveBeenCalledTimes(1)
    ctx.emit('settings/document-updated', 'llm-pi-ai', 1)
    await nextTurn()
    expect(restore.migrate).toHaveBeenCalledTimes(2)
    expect(restore.reviewer).toHaveBeenCalledTimes(2)
  })

  it('coalesces provider transitions while a failed migration is still pending', async () => {
    const first = Promise.withResolvers<void>()
    restore.migrate.mockImplementationOnce(() => first.promise)
    const { native } = await mount()
    try {
      await native.ctx.fiber.restart()
      await nextTurn()
      expect(restore.migrate).toHaveBeenCalledTimes(1)
      first.reject(Error('Provider changed during the write'))
      await nextTurn()
      expect(restore.migrate).toHaveBeenCalledTimes(2)
      expect(restore.reviewer).toHaveBeenCalledTimes(1)
    } finally {
      first.resolve()
    }
  })

  it('keeps a persistent failure idle until a relevant setting or provider changes', async () => {
    restore.migrate.mockRejectedValue(Error('Persistent configuration failure'))
    const { ctx } = await mount()
    await nextTurn()
    ctx.emit('settings/document-updated', 'unrelated-fixture', 1)
    await ctx.plugin({ name: 'unrelated-fixture', apply() {} })
    await nextTurn()
    expect(restore.migrate).toHaveBeenCalledTimes(1)
    ctx.emit('settings/document-updated', 'llm-pi-ai', 1)
    await nextTurn()
    expect(restore.migrate).toHaveBeenCalledTimes(2)
    await nextTurn()
    expect(restore.migrate).toHaveBeenCalledTimes(2)
  })

  it('awaits pending restoration on disposal and skips the reviewer and queued retry', async () => {
    const first = Promise.withResolvers<void>()
    restore.migrate.mockImplementationOnce(() => first.promise)
    const { ctx, native } = await mount()
    let disposed = false
    try {
      await native.ctx.fiber.restart()
      const disposal = ctx.fiber.dispose().then(() => {
        disposed = true
      })
      await nextTurn()
      expect(disposed).toBe(false)
      first.resolve()
      await disposal
      expect(restore.migrate).toHaveBeenCalledTimes(1)
      expect(restore.reviewer).not.toHaveBeenCalled()
    } finally {
      first.resolve()
    }
  })
})
