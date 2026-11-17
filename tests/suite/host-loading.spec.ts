import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'

const migration = vi.hoisted(() => ({ finished: false }))

vi.mock('../../src/gateway/host/index.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/shell/host/git-bash.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/conversation-stats/host/index.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/mcp-apps/host/index.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/gateway/host/model-service.ts', () => ({ GatewayModelsService() {} }))
vi.mock('../../src/setup/host/index.ts', () => ({ SetupService() {} }))
vi.mock('../../src/updates/host/index.ts', () => ({ UpdateService() {} }))
vi.mock('../../src/updates/host/runtime-admission.ts', () => ({
  installUpdateRuntime: () => ({}),
}))
vi.mock('../../src/shared/host/suite-control.ts', () => ({
  name: 'control-fixture',
  inject: [],
  Config: undefined,
  apply(ctx: Context) {
    ctx.provide('qualificationControlReady', true)
  },
}))
vi.mock('../../src/compat/host/model-providers.ts', () => ({
  name: 'migration-fixture',
  inject: [],
  Config: undefined,
  async apply(ctx: Context) {
    // The Windows keyring migration persists through ConfigEditor.edit. The
    // official editor reconciles the profile and waits for this same Loader.
    await ctx.root.loader.await()
    migration.finished = true
  },
}))

import * as suite from '../../src/suite/host.ts'

describe('Suite startup with a profile-writing provider migration', () => {
  it('publishes control and lets the migration finish after the Loader settles', async () => {
    const ctx = new Context()
    migration.finished = false
    await ctx.plugin(Loader)
    for (const name of suite.inject) {
      if (name === 'loader') continue
      ctx.provide(name, name === 'settings' ? { configure: () => () => {} } : {})
    }
    ctx.loader.builtins['qualification-suite'] = suite
    try {
      const starting = ctx.loader.create({
        id: 'opl-suite',
        name: 'cordis:qualification-suite',
        config: {},
      })
      await vi.waitFor(() => expect(ctx.get('qualificationControlReady')).toBe(true), {
        timeout: 1000,
      })
      await starting
      await ctx.loader.await()
      await vi.waitFor(() => expect(migration.finished).toBe(true))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
