import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import {
  editGatewayModels,
  ensureAutoReviewProvider,
  syncGatewayModels,
  discoverGatewayModels,
  gatewayModelSettings,
  migrateGatewayProtocolDefaults,
} from '../../src/gateway/host/model-settings.ts'
function fixture({ officialRedaction = false } = {}) {
  const state: any = {
    'opl-suite': {
      gateway: { models: [{ id: 'deepseek-flash', name: 'DeepSeek' }] },
      gatewayCatalogHashes: {},
    },
    'llm-pi-ai': {
      providers: {
        'opl-gateway-openai': {
          api: 'openai-responses',
          baseURL: 'https://gateway.medopl.com/v1',
          apiKeyEnv: 'OPL_GATEWAY_CODEX_API_KEY',
          models: [{ id: 'gpt-5' }],
        },
      },
    },
  }
  const users: any = { 'opl-suite': {}, 'llm-pi-ai': {} }
  const revisions: Record<string, number> = { 'opl-suite': 0, 'llm-pi-ai': 0 }
  const set = (root: any, path: readonly string[], value: unknown) => {
    for (const key of path.slice(0, -1)) root = root[key] ??= {}
    root[path.at(-1)!] = structuredClone(value)
  }
  const settings = {
    describe: (options?: { redactSecrets?: boolean }) =>
      Object.entries(state).map(([ns, value]) => {
        const descriptor = {
          ns,
          value,
          base:
            ns === 'llm-pi-ai'
              ? {
                  providers: {
                    'opl-gateway-auto-review': {
                      api: 'openai-responses',
                      baseURL: 'https://gateway.medopl.com/v1',
                      apiKeyEnv: 'OPL_GATEWAY_CODEX_API_KEY',
                      models: [{ id: 'codex-auto-review' }],
                    },
                  },
                }
              : {},
          user: users[ns],
          revision: revisions[ns],
        }
        return officialRedaction && options?.redactSecrets && ns === 'llm-pi-ai'
          ? {
              ...descriptor,
              value: redactSecrets(PiAiConfig, descriptor.value).value,
              base: redactSecrets(PiAiConfig, descriptor.base).value,
              user: redactSecrets(PiAiConfig, descriptor.user).value,
            }
          : descriptor
      }),
    mutate: vi.fn(async (ns: string, ops: any[], revision?: number) => {
      if (revision !== undefined && revision !== revisions[ns]) throw Error('conflict')
      for (const op of ops) {
        set(state[ns], op.path, op.value)
        set(users[ns], op.path, op.value)
      }
      revisions[ns]++
    }),
  }
  const discover = vi.fn(async (..._args: unknown[]) => [{ id: 'gpt-new' }])
  const keys = new Map([['OPL_GATEWAY_CODEX_API_KEY', 'fixture']])
  const credentials = {
    resolve: vi.fn(async (ref: string) => (keys.has(ref) ? { value: keys.get(ref)! } : undefined)),
  }
  const account = { status: async () => ({ groups: [{ id: 'codex', state: 'ready' }] }) }
  const ctx = {
    settings,
    credentials,
    llm: {
      listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai' }],
      discoverModels: discover,
    },
    get: (name: string) =>
      name === 'settings'
        ? settings
        : name === 'credentials'
          ? credentials
          : name === 'llm'
            ? ctx.llm
            : name === 'oplGatewayAccount'
              ? account
              : undefined,
    logger: { warn: vi.fn() },
  } as unknown as Context
  return { ctx, state, users, revisions, settings, discover, credentials, keys }
}
describe('native model settings authority', () => {
  it('writes DeepSeek edits to the actual adapter config and keeps an explicitly empty list', async () => {
    const f = fixture()
    await editGatewayModels(f.ctx, { group: 'deepseek', revision: 0, models: [] })
    expect(f.state['opl-suite'].gateway.models).toEqual([])
    expect(f.state['llm-pi-ai'].providers['opl-gateway']).toBeUndefined()
  })
  it('writes Codex edits into the official protocol provider without changing credentials', async () => {
    const f = fixture()
    await editGatewayModels(f.ctx, {
      group: 'codex',
      revision: 0,
      api: 'openai-completions',
      models: [{ id: 'same-id' }],
    })
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai']).toMatchObject({
      models: [{ id: 'same-id' }],
      api: 'openai-completions',
    })
  })
  it('rejects stale edits and duplicate identities', async () => {
    const f = fixture()
    await expect(
      editGatewayModels(f.ctx, { group: 'deepseek', revision: 9, models: [] }),
    ).rejects.toThrow('conflict')
    await expect(
      editGatewayModels(f.ctx, {
        group: 'codex',
        revision: 0,
        api: 'openai-responses',
        models: [{ id: 'a' }, { id: 'a' }],
      }),
    ).rejects.toThrow('重复')
  })
  it('refreshes automatic imports but preserves a later manual model list', async () => {
    const f = fixture()
    await syncGatewayModels(f.ctx)
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([{ id: 'gpt-new' }])
    f.discover.mockResolvedValue([{ id: 'gpt-next' }])
    await syncGatewayModels(f.ctx)
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([
      { id: 'gpt-next' },
    ])
    await editGatewayModels(f.ctx, {
      group: 'codex',
      revision: f.revisions['llm-pi-ai'],
      api: 'openai-responses',
      models: [{ id: 'chosen' }],
    })
    await syncGatewayModels(f.ctx)
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([{ id: 'chosen' }])
    expect(f.discover).toHaveBeenCalledTimes(2)
  })

  it('does not auto-import DeepSeek Flash into the optional OpenAI protocol route', async () => {
    const f = fixture()
    f.discover.mockResolvedValue([{ id: 'deepseek-flash' }, { id: 'gpt-new' }])
    await syncGatewayModels(f.ctx)
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([{ id: 'gpt-new' }])
  })

  it('upgrades only the hidden reviewer when user providers replace bundle providers', async () => {
    const f = fixture()
    const chat = structuredClone(f.state['llm-pi-ai'].providers)
    await ensureAutoReviewProvider(f.ctx)
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai']).toEqual(chat['opl-gateway-openai'])
    expect(f.users['llm-pi-ai'].providers['opl-gateway-auto-review'].models).toEqual([
      { id: 'codex-auto-review' },
    ])
    await ensureAutoReviewProvider(f.ctx)
    expect(f.settings.mutate).toHaveBeenCalledTimes(1)
    expect(f.settings.mutate.mock.calls[0]?.[2]).toBe(0)
  })
  it('preserves an existing hidden provider and refuses stale upgrade writes', async () => {
    const f = fixture()
    f.state['llm-pi-ai'].providers['opl-gateway-auto-review'] = { models: [] }
    await ensureAutoReviewProvider(f.ctx)
    expect(f.settings.mutate).not.toHaveBeenCalled()
    delete f.state['llm-pi-ai'].providers['opl-gateway-auto-review']
    f.settings.mutate.mockRejectedValueOnce(Error('conflict'))
    await expect(ensureAutoReviewProvider(f.ctx)).rejects.toThrow('conflict')
    expect(f.state['llm-pi-ai'].providers['opl-gateway-auto-review']).toBeUndefined()
  })
})

describe('Gateway discovery presentation', () => {
  it('prefers the configured general ID over an unselected version ID without rewriting saved identities', async () => {
    const { gatewayModelChoices } = await import('../../src/gateway/shared/model-choices.ts')
    const version = { id: 'deepseek-v4.1-flash' },
      current = { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }
    expect(gatewayModelChoices([version, current], [current])).toEqual([current])
    expect(gatewayModelChoices([version], [])).toEqual([version])
    expect(gatewayModelChoices([version, current], [version])).toEqual([version, current])
  })
})

const fingerprint = (models: unknown) =>
  createHash('sha256').update(JSON.stringify(models)).digest('hex')
function opusProfile(group: 'aws' | 'kiro') {
  return {
    displayName: `OPL Gateway · ${group === 'aws' ? 'AWS' : 'Kiro'}`,
    api: 'anthropic-messages',
    baseURL: 'https://gateway.medopl.com/v1',
    apiKeyEnv: `OPL_GATEWAY_${group.toUpperCase()}_API_KEY`,
    models: [
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        reasoningEfforts: {
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
      },
    ],
  }
}

describe('protocol prefixes and bundle-owned migration', () => {
  it('coalesces startup and account-refresh migrations without a competing revision write', async () => {
    const f = fixture()
    f.state['llm-pi-ai'].providers['opl-gateway-aws'] = opusProfile('aws')
    await Promise.all([
      migrateGatewayProtocolDefaults(f.ctx),
      migrateGatewayProtocolDefaults(f.ctx),
    ])
    expect(f.state['llm-pi-ai'].providers['opl-gateway-aws']).toMatchObject({
      baseURL: 'https://gateway.medopl.com',
      models: [{ id: 'claude-opus-5-5', compat: { forceAdaptiveThinking: true } }],
    })
    expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  })

  it('refreshes approved automatic inputs and retains catalog hash ownership', async () => {
    const f = fixture(),
      profile = f.state['llm-pi-ai'].providers['opl-gateway-openai']
    profile.models = [
      { id: 'gpt-6-astra', name: 'Chosen label', custom: { nested: [null, true] } },
      { id: 'gpt-6.1-sol', input: ['text'] },
      { id: 'gpt-6.1-terra' },
    ]
    f.users['llm-pi-ai'].providers = { 'opl-gateway-openai': structuredClone(profile) }
    f.state['opl-suite'].gatewayCatalogHashes.codex = fingerprint(profile.models)
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(profile.models).toEqual([
      {
        id: 'gpt-6-astra',
        name: 'Chosen label',
        custom: { nested: [null, true] },
        input: ['text', 'image'],
      },
      { id: 'gpt-6.1-sol', input: ['text', 'image'] },
      { id: 'gpt-6.1-terra', input: ['text', 'image'] },
    ])
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(fingerprint(profile.models))
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(f.settings.mutate).toHaveBeenCalledTimes(2)
  })

  it('completes missing saved inputs when live descriptors include official schema defaults', async () => {
    const f = fixture()
    const raw = {
      ...f.state['llm-pi-ai'].providers['opl-gateway-openai'],
      models: [
        { id: 'gpt-6.1-sol', name: 'Chosen label', custom: { nested: [null, true] } },
        { id: 'gpt-6-astra', input: ['text'] },
        { id: 'gpt-6.1-terra', input: [] },
      ],
    }
    f.users['llm-pi-ai'].providers = { 'opl-gateway-openai': structuredClone(raw) }
    f.state['llm-pi-ai'].providers = structuredClone(
      PiAiConfig({
        providers: { 'opl-gateway-openai': structuredClone(raw) },
      }).providers.get(),
    )
    const profile = f.state['llm-pi-ai'].providers['opl-gateway-openai']
    expect(profile.defaultInput).toEqual(['text'])
    expect(profile.models[0].input).toEqual([])
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((group) => group.id === 'codex')?.models,
    ).toEqual(raw.models)
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(profile.models).toEqual([
      { ...raw.models[0], input: ['text', 'image'] },
      raw.models[1],
      { ...raw.models[2], input: ['text', 'image'] },
    ])
    expect(f.state['opl-suite'].gatewayCatalogHashes).toEqual({})
    expect(f.credentials.resolve).not.toHaveBeenCalled()
    expect(f.discover).not.toHaveBeenCalled()
  })

  it('retains automatic ownership across official schema defaults and secret redaction', async () => {
    const f = fixture({ officialRedaction: true })
    const raw = {
      ...f.state['llm-pi-ai'].providers['opl-gateway-openai'],
      models: [
        {
          id: 'gpt-6.1-sol',
          input: ['text'],
          inputModalities: ['text'],
          custom: { nested: [null, true] },
        },
      ],
    }
    f.users['llm-pi-ai'].providers = { 'opl-gateway-openai': structuredClone(raw) }
    f.state['opl-suite'].gatewayCatalogHashes.codex = fingerprint(raw.models)
    f.state['llm-pi-ai'].providers = structuredClone(
      PiAiConfig({
        providers: { 'opl-gateway-openai': structuredClone(raw) },
      }).providers.get(),
    )
    const profile = f.state['llm-pi-ai'].providers['opl-gateway-openai']
    expect(fingerprint(profile.models)).not.toBe(fingerprint(raw.models))
    const descriptor = f.settings
      .describe({ redactSecrets: true })
      .find((item) => item.ns === 'llm-pi-ai')!
    expect(fingerprint(descriptor.user.providers['opl-gateway-openai'].models)).not.toBe(
      fingerprint(raw.models),
    )
    await migrateGatewayProtocolDefaults(f.ctx)
    const expected = [{ ...raw.models[0], input: ['text', 'image'] }]
    expect(profile.models).toEqual(expected)
    expect(f.users['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual(expected)
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(
      fingerprint(f.users['llm-pi-ai'].providers['opl-gateway-openai'].models),
    )
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(f.settings.mutate).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'Chosen label' },
    { input: ['text', 'image'] },
    { custom: { nested: [null, false] } },
  ])('retains a user-modified catalog after official redaction: %j', async (change) => {
    const f = fixture({ officialRedaction: true })
    const original = {
      id: 'gpt-6.1-sol',
      input: ['text'],
      name: 'Automatic label',
      custom: { nested: [null, true] },
    }
    const raw = {
      ...f.state['llm-pi-ai'].providers['opl-gateway-openai'],
      models: [{ ...original, ...change }],
    }
    f.users['llm-pi-ai'].providers = { 'opl-gateway-openai': structuredClone(raw) }
    const previous = fingerprint([original])
    f.state['opl-suite'].gatewayCatalogHashes.codex = previous
    f.state['llm-pi-ai'].providers = structuredClone(
      PiAiConfig({ providers: { 'opl-gateway-openai': structuredClone(raw) } }).providers.get(),
    )
    const before = structuredClone(f.state['llm-pi-ai'])
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(f.state['llm-pi-ai']).toEqual(before)
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(previous)
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'uses the saved catalog hash for automatic sync after redaction; user changed: %s',
    async (changed) => {
      const f = fixture({ officialRedaction: true })
      const original = {
        id: 'gpt-custom',
        input: ['text'],
        name: 'Automatic label',
        custom: { nested: [null, true] },
      }
      const models = [{ ...original, ...(changed ? { name: 'Chosen label' } : {}) }]
      const raw = {
        ...f.state['llm-pi-ai'].providers['opl-gateway-openai'],
        models,
      }
      f.users['llm-pi-ai'].providers = { 'opl-gateway-openai': structuredClone(raw) }
      const previous = fingerprint([original])
      f.state['opl-suite'].gatewayCatalogHashes.codex = previous
      f.state['llm-pi-ai'].providers = structuredClone(
        PiAiConfig({ providers: { 'opl-gateway-openai': structuredClone(raw) } }).providers.get(),
      )
      f.discover.mockResolvedValue([{ id: 'gpt-next' }])
      await syncGatewayModels(f.ctx)
      const expected = changed ? models : [{ id: 'gpt-next' }]
      expect(f.users['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual(expected)
      expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(
        changed ? previous : fingerprint(expected),
      )
      expect(f.discover).toHaveBeenCalledTimes(changed ? 0 : 1)
    },
  )

  it.each([
    { defaultInput: ['text'] },
    { baseURL: 'https://tenant.invalid/v1' },
    { apiKeyEnv: 'CUSTOM_KEY' },
    { api: 'openai-completions' },
  ])(
    'preserves saved input policy or custom connection with a matching catalog hash: %j',
    async (choice) => {
      const f = fixture({ officialRedaction: true })
      const raw = {
        ...f.state['llm-pi-ai'].providers['opl-gateway-openai'],
        ...choice,
        models: [{ id: 'gpt-6.1-sol', input: ['text'] }],
      }
      f.users['llm-pi-ai'].providers = { 'opl-gateway-openai': structuredClone(raw) }
      f.state['opl-suite'].gatewayCatalogHashes.codex = fingerprint(raw.models)
      f.state['llm-pi-ai'].providers = PiAiConfig({
        providers: { 'opl-gateway-openai': structuredClone(raw) },
      }).providers.get()
      const before = structuredClone(f.state['llm-pi-ai'])
      await migrateGatewayProtocolDefaults(f.ctx)
      expect(f.state['llm-pi-ai']).toEqual(before)
      expect(f.settings.mutate).not.toHaveBeenCalled()
    },
  )

  it('preserves explicit saved text inputs after the automatic catalog hash changes', async () => {
    const f = fixture()
    const raw = {
      ...f.state['llm-pi-ai'].providers['opl-gateway-openai'],
      models: [{ id: 'gpt-6.1-sol', input: ['text'] }],
    }
    f.users['llm-pi-ai'].providers = { 'opl-gateway-openai': structuredClone(raw) }
    f.state['opl-suite'].gatewayCatalogHashes.codex = 'previous-automatic-catalog'
    f.state['llm-pi-ai'].providers = structuredClone(
      PiAiConfig({
        providers: { 'opl-gateway-openai': structuredClone(raw) },
      }).providers.get(),
    )
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(f.users['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual(raw.models)
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe('previous-automatic-catalog')
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('does not refresh inherited text inputs from a catalog hash without a saved model list', async () => {
    const f = fixture()
    const profile = f.state['llm-pi-ai'].providers['opl-gateway-openai']
    profile.models = [{ id: 'gpt-6.1-sol', input: ['text'] }]
    f.state['opl-suite'].gatewayCatalogHashes.codex = fingerprint(profile.models)
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(profile.models).toEqual([{ id: 'gpt-6.1-sol', input: ['text'] }])
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('applies missing input defaults during discovery and editing of a defaulted live route', async () => {
    const f = fixture()
    f.state['llm-pi-ai'].providers = structuredClone(
      PiAiConfig({
        providers: structuredClone(f.state['llm-pi-ai'].providers),
      }).providers.get(),
    )
    f.discover.mockResolvedValue([{ id: 'gpt-6.1-sol' }])
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual([
      { id: 'gpt-6.1-sol', input: ['text', 'image'] },
    ])
    await editGatewayModels(f.ctx, {
      group: 'codex',
      api: 'openai-responses',
      revision: f.revisions['llm-pi-ai'],
      models: [{ id: 'gpt-6.1-sol' }],
    })
    expect(f.users['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([
      { id: 'gpt-6.1-sol', input: ['text', 'image'] },
    ])
  })

  it.each(['aws', 'kiro'] as const)(
    'creates %s with the SDK root and updates only an owned prefix on protocol changes',
    async (group) => {
      const f = fixture()
      await editGatewayModels(f.ctx, {
        group,
        revision: 0,
        api: 'anthropic-messages',
        models: [{ id: 'custom' }],
      })
      const profile = f.state['llm-pi-ai'].providers[`opl-gateway-${group}`]
      expect(profile.baseURL).toBe('https://gateway.medopl.com')
      await editGatewayModels(f.ctx, {
        group,
        revision: 1,
        api: 'openai-responses',
        models: profile.models,
      })
      expect(profile.baseURL).toBe('https://gateway.medopl.com/v1')
      await editGatewayModels(f.ctx, {
        group,
        revision: 2,
        api: 'anthropic-messages',
        models: profile.models,
      })
      expect(profile.baseURL).toBe('https://gateway.medopl.com')
    },
  )

  it.each([
    ['codex', 'opl-gateway-openai', 'openai-responses', 'gpt-6.1-terra'],
    ['gemini', 'opl-gateway-gemini', 'openai-completions', 'gemini-4-argon'],
    ['gemini', 'opl-gateway-gemini', 'openai-completions', 'gemini-3.8-flash'],
  ])(
    'completes an explicitly selected %s model on a newly created route: %s/%s/%s',
    async (group, provider, api, id) => {
      const f = fixture()
      delete f.state['llm-pi-ai'].providers[provider!]
      await editGatewayModels(f.ctx, { group, api, revision: 0, models: [{ id }] })
      expect(f.state['llm-pi-ai'].providers[provider!].models).toEqual([
        { id, input: ['text', 'image'] },
      ])
    },
  )

  it('keeps custom endpoint prefixes and credentials during a protocol edit', async () => {
    const f = fixture(),
      profile = f.state['llm-pi-ai'].providers['opl-gateway-openai']
    Object.assign(profile, {
      baseURL: 'https://tenant.invalid/edge/v1',
      apiKeyEnv: 'CUSTOM_KEY',
      headers: { 'x-tenant': 'tenant' },
    })
    await editGatewayModels(f.ctx, {
      group: 'codex',
      revision: 0,
      api: 'anthropic-messages',
      models: profile.models,
    })
    expect(profile).toMatchObject({
      baseURL: 'https://tenant.invalid/edge/v1',
      apiKeyEnv: 'CUSTOM_KEY',
      headers: { 'x-tenant': 'tenant' },
    })
  })

  it('migrates exact OPL roots and adds only missing adaptive metadata without taking manual catalog ownership', async () => {
    const f = fixture()
    const aws = opusProfile('aws'),
      kiro = opusProfile('kiro')
    f.state['llm-pi-ai'].providers['opl-gateway-aws'] = aws
    f.state['llm-pi-ai'].providers['opl-gateway-kiro'] = kiro
    f.users['llm-pi-ai'].providers = { 'opl-gateway-aws': structuredClone(aws) }
    f.state['opl-suite'].gatewayCatalogHashes.aws = fingerprint(aws.models)
    f.state['opl-suite'].gatewayCatalogHashes.kiro = 'older-auto-import'
    const efforts = structuredClone(aws.models[0]!.reasoningEfforts)
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(aws.baseURL).toBe('https://gateway.medopl.com')
    expect(kiro.baseURL).toBe('https://gateway.medopl.com')
    expect(aws.models[0]).toMatchObject({
      compat: { forceAdaptiveThinking: true },
      reasoningEfforts: efforts,
    })
    expect(f.state['opl-suite'].gatewayCatalogHashes.aws).toBe(fingerprint(aws.models))
    expect(f.state['opl-suite'].gatewayCatalogHashes.kiro).toBe('older-auto-import')
    expect(f.settings.mutate.mock.calls[0]?.[2]).toBe(0)
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(f.settings.mutate).toHaveBeenCalledTimes(2)
  })

  it('preserves custom roots, custom credential references, and an explicit adaptive opt-out', async () => {
    const f = fixture()
    const aws = { ...opusProfile('aws'), baseURL: 'https://tenant.invalid/v1' }
    const kiro = { ...opusProfile('kiro'), apiKeyEnv: 'CUSTOM_KEY' }
    f.state['llm-pi-ai'].providers['opl-gateway-aws'] = aws
    f.state['llm-pi-ai'].providers['opl-gateway-kiro'] = kiro
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(f.settings.mutate).not.toHaveBeenCalled()
    const explicit = {
      ...opusProfile('aws'),
      models: [{ ...aws.models[0], compat: { forceAdaptiveThinking: false } }],
    }
    f.state['llm-pi-ai'].providers['opl-gateway-aws'] = explicit
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(explicit.models[0]!.compat).toEqual({ forceAdaptiveThinking: false })
    expect(explicit.models[0]).toMatchObject({ input: ['text', 'image'] })
    expect(f.settings.mutate.mock.calls[0]?.[1]).toHaveLength(2)
  })
})

describe('per-group catalog observations', () => {
  it('does not equate credential readiness with successful discovery', async () => {
    const f = fixture()
    expect((await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')).toMatchObject({
      ready: true,
      catalog: { state: 'unverified' },
    })
    await discoverGatewayModels(f.ctx, { group: 'codex' })
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')?.catalog,
    ).toEqual({ state: 'ready', count: 1 })
    f.discover.mockResolvedValue([])
    await discoverGatewayModels(f.ctx, { group: 'codex' })
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')?.catalog,
    ).toEqual({ state: 'empty', count: 0 })
  })

  it('uses the effective endpoint prefix and credential reference for Anthropic-group OpenAI listing', async () => {
    const f = fixture()
    f.state['llm-pi-ai'].providers['opl-gateway-aws'] = {
      ...opusProfile('aws'),
      baseURL: 'https://tenant.invalid/edge',
      apiKeyEnv: 'CUSTOM_KEY',
    }
    f.keys.set('CUSTOM_KEY', 'custom-fixture')
    await discoverGatewayModels(f.ctx, { group: 'aws' })
    expect(f.discover).toHaveBeenCalledExactlyOnceWith(
      'llm-pi-ai',
      {
        provider: 'opl-gateway-aws',
        baseURL: 'https://tenant.invalid/edge/v1',
        api: 'openai-completions',
        apiKey: 'custom-fixture',
      },
      expect.any(AbortSignal),
    )
    expect(f.credentials.resolve).toHaveBeenCalledExactlyOnceWith('CUSTOM_KEY')
    f.keys.delete('CUSTOM_KEY')
    await expect(discoverGatewayModels(f.ctx, { group: 'aws' })).rejects.toMatchObject({
      diagnostic: { code: 'missing_credentials' },
    })
    expect(f.discover).toHaveBeenCalledTimes(1)
  })

  it('keeps the OpenAI endpoint exact and rejects unusable endpoint configuration before resolving a key', async () => {
    const f = fixture(),
      profile = f.state['llm-pi-ai'].providers['opl-gateway-openai']
    profile.baseURL = 'https://tenant.invalid/prefix/v7'
    await discoverGatewayModels(f.ctx, { group: 'codex' })
    expect(f.discover.mock.calls[0]?.[1]).toMatchObject({ baseURL: profile.baseURL })
    profile.baseURL = 'https://tenant.invalid/v1?access_token=fixture-private'
    f.credentials.resolve.mockClear()
    await expect(discoverGatewayModels(f.ctx, { group: 'codex' })).rejects.toMatchObject({
      diagnostic: { code: 'configuration' },
    })
    expect(f.credentials.resolve).not.toHaveBeenCalled()
    expect(f.discover).toHaveBeenCalledTimes(1)
  })

  it('retains lossless manually configured model metadata in candidate results', async () => {
    const f = fixture()
    const model = {
      id: 'gpt-new',
      input: ['text'],
      compat: { supportsDeveloperRole: false },
      metadata: { nested: [true, null, { limit: 123 }] },
    }
    f.state['llm-pi-ai'].providers['opl-gateway-openai'].models = [model]
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual([model])
    await editGatewayModels(f.ctx, {
      group: 'codex',
      revision: 0,
      api: 'openai-responses',
      models: [model],
    })
    expect(f.users['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([model])
  })

  it('preserves failed catalogs and their ownership hashes while another group synchronizes', async () => {
    const f = fixture(),
      aws = opusProfile('aws')
    aws.baseURL = 'https://gateway.medopl.com'
    Object.assign(aws.models[0]!, { compat: { forceAdaptiveThinking: true } })
    Object.assign(aws.models[0]!, { input: ['text', 'image'] })
    f.state['llm-pi-ai'].providers['opl-gateway-aws'] = aws
    f.users['llm-pi-ai'].providers = { 'opl-gateway-aws': structuredClone(aws) }
    f.state['opl-suite'].gatewayCatalogHashes.aws = fingerprint(aws.models)
    const previousHash = f.state['opl-suite'].gatewayCatalogHashes.aws
    f.keys.set('OPL_GATEWAY_AWS_API_KEY', 'aws-fixture')
    f.discover.mockImplementation(async (_ns, request: any) => {
      if (request.apiKey === 'aws-fixture')
        throw new LlmError(
          'https://fixture.invalid/secret?key=fixture-private answered 403; check the API key',
          'DISCOVERY_FAILED',
        )
      return [{ id: 'gpt-new' }]
    })
    await syncGatewayModels(f.ctx)
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([{ id: 'gpt-new' }])
    expect(f.state['llm-pi-ai'].providers['opl-gateway-aws']).toEqual(aws)
    expect(f.state['opl-suite'].gatewayCatalogHashes.aws).toBe(previousHash)
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'aws')?.catalog,
    ).toMatchObject({ state: 'error', diagnostic: { code: 'authentication', status: 403 } })
    const visible = JSON.stringify([
      await gatewayModelSettings(f.ctx),
      (f.ctx.logger.warn as any).mock.calls,
    ])
    expect(visible).not.toContain('fixture-private')
    expect(visible).not.toContain('fixture.invalid/secret')
    expect((f.ctx.logger.warn as any).mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('records missing discovery service failures instead of silently skipping all groups', async () => {
    const f = fixture()
    f.discover.mockRejectedValue(new LlmError('service details not for UI', 'NO_DISCOVERY'))
    await syncGatewayModels(f.ctx)
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')?.catalog,
    ).toMatchObject({ state: 'error', diagnostic: { code: 'service_unavailable' } })
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual([{ id: 'gpt-5' }])
    expect(f.state['opl-suite'].gatewayCatalogHashes).toEqual({})
  })

  it('keeps exact default inputs across discovery and repeated automatic imports', async () => {
    const f = fixture()
    f.discover.mockResolvedValue([{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-terra' }])
    const expected = [
      { id: 'gpt-6-astra', input: ['text', 'image'] },
      { id: 'gpt-6.1-terra', input: ['text', 'image'] },
    ]
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual(expected)
    await syncGatewayModels(f.ctx)
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual(expected)
    await syncGatewayModels(f.ctx)
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai'].models).toEqual(expected)
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(fingerprint(expected))
  })

  it('does not add catalog image inputs during custom-endpoint discovery or to an explicit text-only choice', async () => {
    const f = fixture(),
      profile = f.state['llm-pi-ai'].providers['opl-gateway-openai']
    f.discover.mockResolvedValue([{ id: 'gpt-6-astra' }])
    profile.baseURL = 'https://tenant.invalid/v1'
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual([{ id: 'gpt-6-astra' }])
    profile.baseURL = 'https://gateway.medopl.com/v1'
    profile.models = [{ id: 'gpt-6-astra', input: ['text'], custom: { policy: 'manual' } }]
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual(profile.models)
    await migrateGatewayProtocolDefaults(f.ctx)
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })
})
