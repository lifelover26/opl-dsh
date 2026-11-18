import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ gateway: 0, notifications: 0 }))
vi.mock('../../src/shared/client/mount-remotes.ts', () => ({ mountRemotes: async () => {} }))
vi.mock('../../src/shared/client/remote-call.ts', () => ({ optionalRemote: () => undefined }))
vi.mock('../../src/gateway/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {
    state.gateway += 1
  },
}))
vi.mock('../../src/notifications/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {
    state.notifications += 1
  },
}))
vi.mock('../../src/setup/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/compat/client/settings-navigation.ts', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/conversation-stats/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/window-title/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/updates/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/shared/client/FeaturePreferences.tsx', () => ({
  SuiteFeaturePreferences: () => null,
  labels: {},
  SUITE_FEATURE_NAMESPACE: 'fixture.features',
}))
vi.mock('../../src/shell/client.tsx', () => ({
  NativeShellPreference: () => null,
  nativeShellLabels: {},
}))
import * as suite from '../../src/suite/client.tsx'

class StubService extends Service {
  constructor(ctx: Context, name: string, members: object = {}) {
    super(ctx, name)
    Object.assign(this, members)
  }
}

it('starts account and notification features before optional settings arrive and follows their lifetime', async () => {
  const ctx = new Context()
  const rows: { id?: string }[] = []
  let snapshot: { value?: { enhancedConversationStats: boolean } } = {}
  const listeners = new Set<() => void>()
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  try {
    await ctx.plugin({
      apply(provider: Context) {
        new StubService(provider, 'remote')
        new StubService(provider, 'locale', { register: () => () => {} })
        new StubService(provider, 'slots', {
          inject: (_name: string, install: () => unknown) => install(),
          register: (row: { id?: string }) => {
            rows.push(row)
            return provider.effect(() => () => {
              rows.splice(rows.indexOf(row), 1)
            })
          },
        })
      },
    })
    await ctx.plugin(suite)
    expect(state.gateway).toBe(1)
    expect(state.notifications).toBe(1)
    expect(rows).toHaveLength(0)
    const settings = await ctx.plugin({
      apply(provider: Context) {
        new StubService(provider, 'configForms', { get: () => form })
      },
    })
    await vi.waitFor(() =>
      expect(rows.filter((row) => row.id === 'opl-suite-feature-preferences')).toHaveLength(1),
    )
    await settings.dispose()
    expect(state.gateway).toBe(1)
    expect(state.notifications).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})
