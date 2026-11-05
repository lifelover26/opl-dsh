import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config as SuiteConfig } from '../../src/suite/config.ts'
import { GATEWAY_GROUPS } from '../../src/gateway/contracts/groups.ts'
import {
  discoverGatewayModels,
  editGatewayModels,
  ensureAutoReviewProvider,
  gatewayModelSettings,
  migrateGatewayProtocolDefaults,
  syncGatewayModels,
} from '../../src/gateway/host/model-settings.ts'
import { gatewayCatalogStatus } from '../../src/gateway/host/model-diagnostics.ts'
import { gatewayInferenceBaseURL } from '../../src/gateway/host/protocol.ts'

type Values = Record<string, unknown>
interface FixtureEntry {
  id: string
  options: { id: string; config: Values }
  fiber: Fiber
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()!()
  } finally {
    vi.unstubAllGlobals()
  }
})

const fingerprint = (models: unknown) =>
  createHash('sha256').update(JSON.stringify(models)).digest('hex')

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'opl-official-discovery-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const document = join(home, 'profile-fixture.json')
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  const providers = Object.fromEntries(
    GATEWAY_GROUPS.filter((group) => group.id !== 'deepseek').map((group) => [
      group.provider,
      {
        api: group.api,
        apiKeyEnv: group.credential,
        baseURL: `https://fixture.invalid/${group.id}${group.api === 'anthropic-messages' ? '' : '/v1'}`,
        models: [{ id: 'original-' + group.id, input: ['text'] }],
      },
    ]),
  )
  const suiteRaw = {
    gatewayGroups: { kiro: true },
    gatewayCatalogHashes: {} as Record<string, string>,
    gateway: {
      baseURL: 'https://fixture.invalid/deepseek/v1',
      apiKeyEnv: 'FIXTURE_DEEPSEEK',
      models: [{ id: 'original-deepseek', inputModalities: ['text'] }],
    },
  }
  root.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
  root.provide('loader', { await: async () => {} })
  root.provide('profileContext', { home, name: 'fixture', patchPath: document })
  await root.plugin(LlmRuntime)
  const native = root.plugin(PiAi, { providers })
  await native
  const suite = root.plugin({ name: 'suite-fixture', Config: SuiteConfig, apply() {} }, suiteRaw)
  await suite
  const entries: FixtureEntry[] = [
    {
      id: 'fixture-pi-ai',
      options: { id: 'llm-pi-ai', config: { providers } },
      fiber: native.ctx.fiber,
    },
    { id: 'fixture-suite', options: { id: 'opl-suite', config: suiteRaw }, fiber: suite.ctx.fiber },
  ]
  const saved: Record<string, Values> = { 'llm-pi-ai': {}, 'opl-suite': {} }
  const inherited = new Map(entries.map((entry) => [entry, structuredClone(entry.options.config)]))
  // SettingsForms owns projection, path validation and revision checks. This
  // editor persists only the isolated profile and applies real Cordis updates.
  root.provide('configEditor', {
    entries: () => entries,
    configuration: () =>
      entries.map((entry) => ({
        entry,
        inherited: inherited.get(entry),
        override: saved[entry.options.id],
      })),
    edit: async (entry: FixtureEntry, change: (raw: Values, base: Values) => Values) => {
      const next = change(structuredClone(entry.options.config), inherited.get(entry)!)
      await writeFile(document, JSON.stringify({ ...saved, [entry.options.id]: next }))
      saved[entry.options.id] = structuredClone(next)
      entry.options.config = next
      await entry.fiber.update(next, true)
    },
  })
  const settings = root.plugin(SettingsForms)
  await settings
  const credentials = root.plugin({
    name: 'fixture-credentials',
    apply(ctx: Context) {
      ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-key' }) })
    },
  })
  await credentials
  let caller!: Context
  await root.plugin({
    name: 'gateway/internal',
    inject: ['llm'],
    apply(ctx: Context) {
      caller = ctx
    },
  })
  const directoryURLs = new Map(
    GATEWAY_GROUPS.map((group) => [group.id, `https://fixture.invalid/${group.id}/v1/models`]),
  )
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const group = [...directoryURLs].find(([, url]) => url === request.url)?.[0]
    expect(group).toBeDefined()
    expect(request.method).toBe('GET')
    expect(request.headers.get('authorization')).toBe('Bearer fixture-key')
    expect(request.headers.get('x-api-key')).toBeNull()
    return Response.json({ data: [{ id: 'listed-' + group }] })
  })
  vi.stubGlobal('fetch', fetch)
  const persisted = async () => JSON.parse(await readFile(document, 'utf8'))
  return { root, caller, entries, saved, settings, credentials, fetch, directoryURLs, persisted }
}

describe('automatic Gateway discovery through official services', () => {
  it('fetches all six directories from an uninjected caller and persists their models and hashes', async () => {
    const f = await fixture()
    expect(() => f.caller.settings).toThrow('without inject')
    await syncGatewayModels(f.caller)
    expect(f.fetch).toHaveBeenCalledTimes(6)
    const persisted = await f.persisted()
    const snapshot = await gatewayModelSettings(f.caller)
    for (const group of GATEWAY_GROUPS) {
      expect(gatewayCatalogStatus(f.caller, group.id)).toEqual({ state: 'ready', count: 1 })
      expect(snapshot.groups.find((item) => item.id === group.id)?.models).toEqual([
        {
          id: 'listed-' + group.id,
          name: 'listed-' + group.id,
          ...(group.id === 'deepseek' ? { inputModalities: ['text'] } : {}),
        },
      ])
      const models =
        group.id === 'deepseek'
          ? persisted['opl-suite'].gateway.models
          : persisted['llm-pi-ai'].providers[group.provider].models
      expect(models).toEqual([{ id: 'listed-' + group.id, name: 'listed-' + group.id }])
      expect(persisted['opl-suite'].gatewayCatalogHashes[group.id]).toBe(fingerprint(models))
    }
  })

  it('records empty official listings without replacing existing model lists', async () => {
    const f = await fixture()
    f.fetch.mockImplementation(async () => Response.json({ data: [] }))
    const before = f.entries.map((entry) => structuredClone(entry.options.config))
    await syncGatewayModels(f.caller)
    expect(f.fetch).toHaveBeenCalledTimes(6)
    for (const group of GATEWAY_GROUPS)
      expect(gatewayCatalogStatus(f.caller, group.id)).toEqual({ state: 'empty', count: 0 })
    expect(f.entries.map((entry) => entry.options.config)).toEqual(before)
    expect(f.saved).toEqual({ 'llm-pi-ai': {}, 'opl-suite': {} })
  })

  it('keeps a saved manual text policy and custom connection when other groups synchronize', async () => {
    const f = await fixture()
    const native = f.entries[0]!
    const profile = (native.options.config.providers as Record<string, Values>)[
      'opl-gateway-openai'
    ]!
    Object.assign(profile, {
      api: 'openai-completions',
      apiKeyEnv: 'CUSTOM_CODEX',
      baseURL: 'https://fixture.invalid/user-codex/v1',
      defaultInput: ['text'],
      models: [{ id: 'gpt-6.1-sol', input: ['text'], metadata: { policy: 'manual' } }],
    })
    await native.fiber.update(native.options.config, true)
    f.saved['llm-pi-ai'] = { providers: { 'opl-gateway-openai': structuredClone(profile) } }
    const before = structuredClone(profile)
    await syncGatewayModels(f.caller)
    expect(f.fetch).toHaveBeenCalledTimes(5)
    expect(
      (native.options.config.providers as Record<string, Values>)['opl-gateway-openai'],
    ).toEqual(before)
    expect((await f.persisted())['llm-pi-ai'].providers['opl-gateway-openai']).toEqual(before)
    expect((await f.persisted())['opl-suite'].gatewayCatalogHashes.codex).toBeUndefined()
  })

  it('migrates and edits a bundled route through the same strict settings context', async () => {
    const f = await fixture()
    const native = f.entries[0]!
    const profile = (native.options.config.providers as Record<string, Values>)[
      'opl-gateway-openai'
    ]!
    Object.assign(profile, {
      baseURL: gatewayInferenceBaseURL('openai-responses'),
      models: [{ id: 'gpt-6.1-sol', input: [] }],
    })
    await native.fiber.update(native.options.config, true)
    await migrateGatewayProtocolDefaults(f.caller)
    expect((await f.persisted())['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([
      {
        id: 'gpt-6.1-sol',
        input: ['text', 'image'],
        compat: { chatTemplateArgs: {}, chatTemplateKwargs: {} },
      },
    ])
    const revision = (await gatewayModelSettings(f.caller)).groups.find(
      (group) => group.id === 'codex',
    )!.revision
    await editGatewayModels(f.caller, {
      group: 'codex',
      api: 'openai-responses',
      revision,
      models: [{ id: 'gpt-6.1-sol', input: ['text'] }],
    })
    await migrateGatewayProtocolDefaults(f.caller)
    expect((await f.persisted())['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([
      { id: 'gpt-6.1-sol', input: ['text'] },
    ])
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('synchronizes sibling inherited catalogs materialized by the protocol migration', async () => {
    const f = await fixture()
    f.directoryURLs.set('codex', gatewayInferenceBaseURL('openai-responses') + '/models')
    const native = f.entries[0]!
    const profile = (native.options.config.providers as Record<string, Values>)[
      'opl-gateway-openai'
    ]!
    Object.assign(profile, {
      baseURL: gatewayInferenceBaseURL('openai-responses'),
      models: [{ id: 'gpt-6.1-sol', input: [] }],
    })
    await native.fiber.update(native.options.config, true)
    await migrateGatewayProtocolDefaults(f.caller)
    await syncGatewayModels(f.caller)
    expect(f.fetch).toHaveBeenCalledTimes(6)
    const persisted = await f.persisted()
    for (const group of GATEWAY_GROUPS) {
      expect(gatewayCatalogStatus(f.caller, group.id)).toEqual({ state: 'ready', count: 1 })
      const models =
        group.id === 'deepseek'
          ? persisted['opl-suite'].gateway.models
          : persisted['llm-pi-ai'].providers[group.provider].models
      expect(models.map((model: Values) => model.id)).toEqual(['listed-' + group.id])
      expect(persisted['opl-suite'].gatewayCatalogHashes[group.id]).toBe(fingerprint(models))
    }
  })

  it('rejects a stale import and preserves user policies changed after sibling defaults were copied', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const ordinary = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (...args) => {
      const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]))
      if (url.pathname.includes('/grok/')) {
        entered.resolve()
        await release.promise
      }
      return ordinary(...args)
    })
    const pending = syncGatewayModels(f.caller)
    cleanups.push(async () => {
      release.resolve()
      await pending
    })
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw Error('Synchronization ended before the Grok request barrier')
      }),
    ])
    const revision = f.root.settings.describe().find((item) => item.ns === 'llm-pi-ai')!.revision
    const manual = {
      baseURL: 'https://fixture.invalid/user-gemini/v1',
      defaultInput: ['text'],
      models: [{ id: 'manual-gemini', input: ['text'], metadata: { policy: 'manual' } }],
    }
    try {
      await f.root.settings.mutate(
        'llm-pi-ai',
        Object.entries(manual).map(([key, value]) => ({
          op: 'set',
          path: ['providers', 'opl-gateway-gemini', key],
          value,
        })),
        revision,
      )
    } finally {
      release.resolve()
    }
    await pending
    expect(f.fetch).toHaveBeenCalledTimes(3)
    expect(gatewayCatalogStatus(f.caller, 'grok')).toMatchObject({
      state: 'error',
      diagnostic: { code: 'settings_conflict' },
    })
    const persisted = await f.persisted()
    expect(persisted['llm-pi-ai'].providers['opl-gateway-gemini']).toMatchObject(manual)
    expect(persisted['llm-pi-ai'].providers['opl-gateway-grok'].models).toEqual([
      { id: 'original-grok', input: ['text'] },
    ])
    expect(persisted['opl-suite'].gatewayCatalogHashes.grok).toBeUndefined()
    expect(persisted['opl-suite'].gatewayCatalogHashes.gemini).toBeUndefined()
  })

  it('retains an owned catalog and hash when the official endpoint refuses it', async () => {
    const f = await fixture()
    const native = f.entries[0]!
    const profile = (native.options.config.providers as Record<string, Values>)['opl-gateway-aws']!
    f.saved['llm-pi-ai'] = { providers: { 'opl-gateway-aws': structuredClone(profile) } }
    const previousHash = fingerprint(profile.models)
    const suite = f.entries[1]!
    ;(suite.options.config.gatewayCatalogHashes as Record<string, string>).aws = previousHash
    await suite.fiber.update(suite.options.config, true)
    const ordinary = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (...args) => {
      const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]))
      return url.pathname.includes('/aws/')
        ? new Response('private-response-body', { status: 403 })
        : ordinary(...args)
    })
    await syncGatewayModels(f.caller)
    expect(f.fetch).toHaveBeenCalledTimes(6)
    expect(gatewayCatalogStatus(f.caller, 'aws')).toMatchObject({
      state: 'error',
      diagnostic: { code: 'authentication', status: 403 },
    })
    const persisted = await f.persisted()
    expect(persisted['llm-pi-ai'].providers['opl-gateway-aws']).toEqual(profile)
    expect(persisted['opl-suite'].gatewayCatalogHashes.aws).toBe(previousHash)
    expect(JSON.stringify(gatewayCatalogStatus(f.caller, 'aws'))).not.toContain(
      'private-response-body',
    )
  })

  it('refuses retired settings and credential services before any discovery request', async () => {
    const f = await fixture()
    await f.credentials.ctx.fiber.dispose()
    await expect(discoverGatewayModels(f.caller, { group: 'codex' })).rejects.toMatchObject({
      diagnostic: { code: 'service_unavailable' },
    })
    await f.settings.ctx.fiber.dispose()
    await expect(discoverGatewayModels(f.caller, { group: 'codex' })).rejects.toMatchObject({
      diagnostic: { code: 'service_unavailable' },
    })
    for (const operation of [
      () => migrateGatewayProtocolDefaults(f.caller),
      () => ensureAutoReviewProvider(f.caller),
      () => gatewayModelSettings(f.caller),
      () => syncGatewayModels(f.caller),
      () =>
        editGatewayModels(f.caller, {
          group: 'codex',
          revision: 0,
          api: 'openai-responses',
          models: [],
        }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'SETTINGS_UNAVAILABLE' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
