import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as official from '@deepseek-ai/dsh-llm-pi-ai'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as providers from '../../src/compat/host/model-providers.ts'
import { BAMBOO_STARTLUX_CREDENTIAL_REF } from '../../src/credentials/contracts/windows-keyring.ts'
import { jevTypeSafeKeyring } from '../../src/credentials/host/windows-keyring.ts'
import { listAdvertisedRoutes } from '../../src/auto-review/host/routes.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const bambooKeyring = vi.hoisted(() => ({
  describe: vi.fn().mockResolvedValue({
    configured: false,
    source: 'windows-credential-manager',
    supported: true,
    available: true,
  }),
}))
vi.mock('../../src/credentials/host/windows-keyring.ts', () => ({
  jevTypeSafeKeyring: {
    read: vi.fn().mockResolvedValue(undefined),
    set: vi.fn(),
    remove: vi.fn(),
    describe: vi.fn().mockResolvedValue({
      configured: false,
      supported: true,
      available: true,
      source: 'windows-credential-manager',
    }),
  },
  bambooStartLuxKeyring: {
    target: 'OPLDSH:BambooStartLux:ApiKey',
    read: vi.fn().mockResolvedValue(undefined),
    set: vi.fn(),
    remove: vi.fn(),
    describe: bambooKeyring.describe,
  },
}))
beforeEach(() => {
  bambooKeyring.describe.mockReset()
  bambooKeyring.describe.mockResolvedValue({
    configured: false,
    source: 'windows-credential-manager',
    supported: true,
    available: true,
  })
})

describe('native decision-provider integration', () => {
  it('registers StartLux when its keyring is configured even without a profile draft', async () => {
    bambooKeyring.describe.mockResolvedValue({
      configured: true,
      source: 'windows-credential-manager',
      supported: true,
      available: true,
    })
    const ctx = new Context()
    const home = await mkdtemp(join(tmpdir(), 'opl-startlux-route-'))
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalCredentialProvider, {
        path: join(home, '.credentials.yaml'),
        watch: false,
      })
      const mutate = vi.fn(async () => {})
      ctx.provide('settings', {
        configure: () => () => {},
        describe: () => [{ ns: 'llm-pi-ai', revision: 0 }],
        mutate,
      })
      const native = ctx.plugin(official, {})
      await native
      ctx.provide('loader', {
        entries: () => [
          {
            options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
            fiber: native.ctx.fiber,
          },
        ],
      })
      await ctx.plugin(providers)
      if (process.platform !== 'win32') expect(mutate).not.toHaveBeenCalled()
      expect(
        ctx.llm.listConfigurableProviders().some((item) => item.provider === 'huawei-maas'),
      ).toBe(false)
      expect(ctx.llm.listProviders().some((item) => item.id === 'opencode-jev')).toBe(true)
      expect(ctx.llm.listProviders().some((item) => item.id === 'typesafe-jev')).toBe(false)
      expect(
        ctx.llm.listConfigurableProviders().some((item) => item.provider === 'typesafe-jev'),
      ).toBe(true)
      expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'typesafe-jev' })).toEqual([
        { id: 'jev-1.13.0', name: 'Jev 1.13' },
      ])
      vi.mocked(jevTypeSafeKeyring.describe).mockResolvedValue({
        configured: true,
        supported: true,
        available: true,
        source: 'windows-credential-manager',
      })
      await ctx.credentials.set(credentialRef('TYPESAFE_JEV_API_KEY'), 'synthetic-jev-key')
      await vi.waitFor(() =>
        expect(ctx.llm.listProviders().some((item) => item.id === 'typesafe-jev')).toBe(true),
      )
      expect(await listAdvertisedRoutes(ctx)).toContainEqual(
        expect.objectContaining({
          provider: 'typesafe-jev',
          model: 'jev-1.13.0',
          kind: 'decision',
        }),
      )
      vi.mocked(jevTypeSafeKeyring.describe).mockResolvedValue({
        configured: false,
        supported: true,
        available: true,
        source: 'windows-credential-manager',
      })
      await ctx.credentials.unset(credentialRef('TYPESAFE_JEV_API_KEY'))
      await vi.waitFor(() =>
        expect(ctx.llm.listProviders().some((item) => item.id === 'typesafe-jev')).toBe(false),
      )

      expect(await listAdvertisedRoutes(ctx)).toContainEqual({
        provider: 'opencode-jev',
        providerName: 'OpenCode · Jev',
        model: 'jev-1.13-free',
        modelName: 'Jev 1.13 Free',
        kind: 'decision',
        efforts: [],
        defaultEffort: null,
      })
      expect(ctx.llm.listProviders().some((item) => item.id === 'bamboo-startlux')).toBe(true)
      expect(await ctx.llm.listModels('bamboo-startlux')).toEqual([
        {
          provider: 'bamboo-startlux',
          id: 'startlux-decision-27b-autothink',
          name: 'StartLux Decision 27B AutoThink',
        },
      ])
      expect(await listAdvertisedRoutes(ctx)).toContainEqual({
        provider: 'bamboo-startlux',
        providerName: 'BambooNode · StartLux',
        model: 'startlux-decision-27b-autothink',
        modelName: 'StartLux Decision 27B AutoThink',
        kind: 'decision',
        efforts: [],
        defaultEffort: null,
      })
      bambooKeyring.describe.mockResolvedValueOnce({
        configured: false,
        source: 'windows-credential-manager',
        supported: true,
        available: true,
      })
      ctx.emit('credentials/reference-updated', credentialRef(BAMBOO_STARTLUX_CREDENTIAL_REF))
      await vi.waitFor(() =>
        expect(ctx.llm.listProviders().some((item) => item.id === 'bamboo-startlux')).toBe(false),
      )
      bambooKeyring.describe.mockResolvedValueOnce({
        configured: true,
        source: 'windows-credential-manager',
        supported: true,
        available: true,
      })
      ctx.emit('credentials/reference-updated', credentialRef(BAMBOO_STARTLUX_CREDENTIAL_REF))
      await vi.waitFor(() =>
        expect(ctx.llm.listProviders().some((item) => item.id === 'bamboo-startlux')).toBe(true),
      )
      const info = {
        configured: true,
        source: 'windows-credential-manager',
        supported: true,
        available: true,
      }
      const oldRead = Promise.withResolvers<typeof info>()
      const newRead = Promise.withResolvers<typeof info>()
      bambooKeyring.describe
        .mockReturnValueOnce(oldRead.promise)
        .mockReturnValueOnce(newRead.promise)
      ctx.emit('credentials/reference-updated', credentialRef(BAMBOO_STARTLUX_CREDENTIAL_REF))
      ctx.emit('credentials/reference-updated', credentialRef(BAMBOO_STARTLUX_CREDENTIAL_REF))
      newRead.resolve({ ...info, configured: false })
      await vi.waitFor(() =>
        expect(ctx.llm.listProviders().some((item) => item.id === 'bamboo-startlux')).toBe(false),
      )
      oldRead.resolve(info)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(ctx.llm.listProviders().some((item) => item.id === 'bamboo-startlux')).toBe(false)

      const pendingRead = Promise.withResolvers<typeof info>()
      bambooKeyring.describe.mockReturnValueOnce(pendingRead.promise)
      ctx.emit('credentials/reference-updated', credentialRef(BAMBOO_STARTLUX_CREDENTIAL_REF))
      const llm = ctx.llm
      await ctx.fiber.dispose()
      pendingRead.resolve(info)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(llm.listProviders().some((item) => item.id === 'bamboo-startlux')).toBe(false)
      expect(llm.listProviders().some((item) => item.id === 'opencode-jev')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})
