import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  gatewayGroupEnabled,
  setGatewayGroupEnabled,
} from '../../src/gateway/host/group-settings.ts'
import {
  gatewayCatalogStatus,
  setGatewayCatalogStatus,
} from '../../src/gateway/host/model-diagnostics.ts'
import { displayModelName, selectableModels } from '../../src/execution/contracts/catalog.ts'
import { defaultHarness, nativeHarnessMatches } from '../../src/execution/host/harness.ts'
describe('account activation and explicit paid channels', () => {
  it('preserves existing groups, keeps new Kiro optional, and separates activation from key ownership', async () => {
    const settings = {
      describe: () => [{ ns: 'opl-suite', revision: 4, value: { gatewayGroups: { aws: false } } }],
      mutate: vi.fn(async () => {}),
    }
    const account = { refresh: vi.fn(async () => ({ groups: [] })) }
    const ctx = {
      get: (key: string) =>
        key === 'settings' ? settings : key === 'oplGatewayAccount' ? account : undefined,
      settings,
    } as unknown as Context
    expect(gatewayGroupEnabled(ctx, 'codex')).toBe(true)
    expect(gatewayGroupEnabled(ctx, 'kiro')).toBe(false)
    expect(gatewayGroupEnabled(ctx, 'aws')).toBe(false)
    await setGatewayGroupEnabled(ctx, 'kiro', true)
    expect(settings.mutate).toHaveBeenCalledWith(
      'opl-suite',
      [{ op: 'set', path: ['gatewayGroups', 'kiro'], value: true }],
      4,
    )
    expect(account.refresh).toHaveBeenCalledOnce()
    setGatewayCatalogStatus(ctx, 'kiro', {
      state: 'error',
      diagnostic: { code: 'network', message: '无法连接目录服务' },
    })
    await setGatewayGroupEnabled(ctx, 'kiro', false)
    expect(gatewayCatalogStatus(ctx, 'kiro')).toEqual({ state: 'unverified' })
    await expect(setGatewayGroupEnabled(ctx, 'invalid', true)).rejects.toThrow()
  })
  it('reports a missing account service without hiding the saved group change', async () => {
    const settings = {
      describe: () => [{ ns: 'opl-suite', revision: 7, value: { gatewayGroups: { aws: true } } }],
      mutate: vi.fn(async () => {}),
    }
    const ctx = {
      get: (key: string) => (key === 'settings' ? settings : undefined),
      settings,
    } as unknown as Context
    await expect(setGatewayGroupEnabled(ctx, 'aws', false)).rejects.toThrow('网关账号服务尚未就绪')
    expect(settings.mutate).toHaveBeenCalledWith(
      'opl-suite',
      [{ op: 'set', path: ['gatewayGroups', 'aws'], value: false }],
      7,
    )
  })
  it('keeps every Claude channel selectable with distinct labels and native harness defaults', () => {
    const models = ['claude', 'aws', 'kiro'].map((group) => ({
      ref: { provider: 'opl-gateway', model: group + '::claude-opus-5-5' },
      name: 'Claude Opus 5.5',
      source: 'OPL Gateway',
      available: true,
    }))
    expect(selectableModels(models)).toHaveLength(3)
    expect(models.map((m) => displayModelName(m.ref, m.name))).toEqual([
      'Claude Opus 5.5 · Claude',
      'Claude Opus 5.5 · AWS',
      'Claude Opus 5.5 · Kiro',
    ])
    expect(models.map((m) => defaultHarness(m.ref))).toEqual(['claude', 'claude', 'claude'])
    expect(defaultHarness({ provider: 'opl-gateway', model: 'codex::gpt-6-astra' })).toBe('codex')
    expect(nativeHarnessMatches('codex', models[0]!.ref)).toBe(false)
  })
})
