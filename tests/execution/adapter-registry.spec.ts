import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterFor, defaultHarness } from '../../src/execution/host/adapters/index.ts'
import {
  isOfficialPairing,
  officialHarnessFor,
} from '../../src/execution/contracts/official-harnesses.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
const BIG_PICKLE = { provider: 'our-free-model', model: 'big-pickle' } as const
const FLINT = { provider: 'our-free-model', model: 'flint-40b-free' } as const
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('official Harness adapter registry', () => {
  it('matches supported model and executable pairs without falling back to a different runtime', () => {
    const gpt = { provider: 'opl-gateway', model: 'codex::gpt-current' }
    const claude = { provider: 'opl-gateway', model: 'aws::claude-sonnet-current' }
    expect(adapterFor('codex', gpt)?.id).toBe('codex')
    expect(adapterFor('codex', claude)).toBeUndefined()
    expect(adapterFor('antigravity', gpt)).toBeUndefined()
    expect(defaultHarness(gpt)).toBe('codex')
    expect(defaultHarness(claude)).toBe('claude')
    const gatewayGemini = { provider: 'opl-gateway', model: 'gemini::gemini-3.8-flash' }
    expect(adapterFor('opencode', gatewayGemini)?.id).toBe('opencode')
    expect(defaultHarness(gatewayGemini)).toBe('antigravity')
    expect(adapterFor('antigravity', gatewayGemini)?.id).toBe('antigravity')
    expect(defaultHarness({ provider: 'opl-gateway', model: 'gemini::gemini-4-argon' })).toBe(
      'antigravity',
    )
    expect(
      adapterFor('opencode', { provider: 'opl-gateway', model: 'gemini::gemini-3.1-pro' }),
    ).toBeUndefined()
    expect(defaultHarness({ provider: 'opl-gateway', model: 'gemini::gemini-3.1-pro' })).toBe('dsh')
    expect(
      adapterFor('opencode', { provider: 'opl-gateway', model: 'gemini::gemini-3.7-flash' }),
    ).toBeUndefined()
    expect(defaultHarness({ provider: 'custom', model: 'gpt-current' })).toBe('dsh')
  })
  it('treats generic runners as having no official model pairing', () => {
    expect(officialHarnessFor(BIG_PICKLE)).toBeUndefined()
    expect(officialHarnessFor(FLINT)).toBeUndefined()
    for (const id of ['opencode', 'kilo', 'pi'])
      expect(isOfficialPairing(id, BIG_PICKLE)).toBe(false)
    expect(isOfficialPairing('codex', { provider: 'opl-gateway', model: 'codex::gpt-5' })).toBe(
      true,
    )
    expect(isOfficialPairing('codex', BIG_PICKLE)).toBe(false)
    expect(isOfficialPairing('dsh', { provider: 'custom', model: 'gpt-current' })).toBe(false)
  })

  it('keeps selected-channel credentials and per-session homes inside the chosen native process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opl-adapter-'))
    roots.push(home)
    vi.stubEnv('OPENAI_API_KEY', 'must-not-inherit')
    vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-inherit')
    vi.stubEnv('OPL_GATEWAY_GROK_API_KEY', 'must-not-inherit')
    const resolve = vi.fn(async (ref: string) => ({ value: `test-${ref}` }))
    const ctx = { get: () => undefined, credentials: { resolve } } as unknown as Context
    const options = {
      home,
      command: process.execPath,
      grokCommand: process.execPath,
      nativeBridgePath: '/owned/native-harness-bridge.mjs',
    }
    const record = {
      id: 'one',
      cwd: home,
      sandbox: 'read-only',
      harnessRef: 'codex',
      modelRef: { provider: 'opl-gateway', model: 'codex::gpt-current' },
    } as HarnessSession
    const codex = await adapterFor('codex', record.modelRef)!.prepare!(ctx, record, options)
    expect(codex.command).toBe(process.execPath)
    expect(codex.args).toEqual([options.nativeBridgePath])
    expect(codex.env.OPL_NATIVE_COMMAND).toBe(process.execPath)
    expect(codex.env.OPL_NATIVE_PERMISSION).toBe('read-only')
    expect(codex.env.CODEX_HOME).toBe(join(home, 'harnesses/codex/one'))
    expect(codex.env.OPENAI_API_KEY).toBeUndefined()
    expect(codex.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(codex.env.OPL_GATEWAY_GROK_API_KEY).toBeUndefined()
    expect(resolve).toHaveBeenLastCalledWith('OPL_GATEWAY_CODEX_API_KEY')
    const claudeRecord = {
      ...record,
      harnessRef: 'claude',
      modelRef: { provider: 'opl-gateway', model: 'aws::claude-sonnet-current' },
    }
    const claude = await adapterFor('claude', claudeRecord.modelRef)!.prepare!(
      ctx,
      claudeRecord,
      options,
    )
    expect(resolve).toHaveBeenLastCalledWith('OPL_GATEWAY_AWS_API_KEY')
    expect(claude.env.CLAUDE_CONFIG_DIR).toBe(join(home, 'harnesses/claude/one'))
    expect(claude.env.ANTHROPIC_API_KEY).toBe(claude.env.OPL_NATIVE_API_KEY)
    expect(claude.env.CODEX_HOME).toBeUndefined()
    expect(claude.env.ANTHROPIC_BASE_URL).not.toMatch(/\/v1\/?$/)
  })
  it('withdraws retired Huawei routes without affecting OFM engines', () => {
    for (const ref of [
      { provider: 'huawei-maas', model: 'glm-5.2' },
      { provider: 'huawei-maas', model: 'kimi-k2.6' },
      { provider: 'huawei-maas', model: 'deepseek-v4-flash' },
    ]) {
      expect(officialHarnessFor(ref)).toBeUndefined()
      expect(adapterFor('zcode', ref)).toBeUndefined()
      expect(adapterFor('kimi-code', ref)).toBeUndefined()
    }
    expect(adapterFor('zcode', { provider: 'our-free-model', model: 'z-ai/glm-5.3' })?.id).toBe(
      'zcode',
    )
  })
})
