import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { googleProvider } from '@earendil-works/pi-ai/providers/google'
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode'
import { streamSimple as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { streamSimple as streamMessages } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import type { Context as PiContext, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { GATEWAY_GROUPS, type GatewayGroupId } from '../../src/gateway/contracts/groups.ts'
import {
  GATEWAY_MODEL_INPUT_DEFAULTS,
  withGatewayModelInputDefaults,
} from '../../src/gateway/host/model-capabilities.ts'
import { gatewayInferenceBaseURL } from '../../src/gateway/host/protocol.ts'
import { resolveGatewayExecution } from '../../src/gateway/host/execution-access.ts'
import type { ModelDraft } from '../../src/gateway/contracts/models.ts'

afterEach(() => vi.unstubAllGlobals())
const patch = parse(await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
})
const profiles = patch.find((entry: { id?: string }) => entry.id === 'llm-pi-ai').config.providers
function connection(group: GatewayGroupId) {
  const definition = GATEWAY_GROUPS.find((entry) => entry.id === group)!
  return {
    api: definition.api,
    apiKeyEnv: definition.credential,
    baseURL: gatewayInferenceBaseURL(definition.api),
  }
}

function catalogModel(entry: (typeof GATEWAY_MODEL_INPUT_DEFAULTS)[number]) {
  const providers = {
    codex: openaiProvider(),
    aws: anthropicProvider(),
    kiro: anthropicProvider(),
    grok: xaiProvider(),
    gemini: googleProvider(),
  }
  const provider =
    entry.group === 'gemini' && entry.id === 'gemini-3.1-pro'
      ? opencodeProvider()
      : providers[entry.group]
  return provider.getModels().find((model) => model.id === entry.id)
}

describe('exact Gateway input defaults', () => {
  it.each(GATEWAY_MODEL_INPUT_DEFAULTS)(
    'matches its public provider catalog and any existing seed for $group/$id',
    (entry) => {
      const model = catalogModel(entry)
      expect(model, `${entry.group}/${entry.id}`).toBeDefined()
      expect(entry.input).toEqual(model!.input)
      const definition = GATEWAY_GROUPS.find((group) => group.id === entry.group)!
      const seed = profiles[definition.provider]?.models.find(
        (model: ModelDraft) => model.id === entry.id,
      )
      if (seed) expect(seed.input).toEqual(model!.input)
      else
        expect(['gpt-6.1-terra', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.1-pro']).toContain(
          entry.id,
        )
      const draft = {
        id: entry.id,
        name: 'Manual label',
        compat: { supportsDeveloperRole: false },
        custom: { nested: [null, true] },
      }
      expect(withGatewayModelInputDefaults(entry.group, connection(entry.group), [draft])).toEqual([
        { ...draft, input: [...model!.input] },
      ])
      expect(
        withGatewayModelInputDefaults(entry.group, connection(entry.group), [
          { ...draft, input: [] },
        ]),
      ).toEqual([{ ...draft, input: [...model!.input] }])
    },
  )

  it('only fills the approved route/model pairs, preserving unknown and other-family IDs', () => {
    expect(GATEWAY_MODEL_INPUT_DEFAULTS).toHaveLength(11)
    const models = [
      { id: 'gpt-6.1-terra-unlisted' },
      { id: 'gpt-future' },
      { id: 'claude-opus-5-5' },
    ]
    expect(withGatewayModelInputDefaults('codex', connection('codex'), models)).toEqual(models)
    expect(
      withGatewayModelInputDefaults('gemini', connection('gemini'), [
        { id: 'gemini-3.1-pro-unlisted' },
        { id: 'gemini-3.1-pro-preview' },
      ]),
    ).toEqual([{ id: 'gemini-3.1-pro-unlisted' }, { id: 'gemini-3.1-pro-preview' }])
  })

  it('preserves nonempty model inputs and route input policy', () => {
    const models = [
      { id: 'gpt-6-astra', input: ['text'] },
      { id: 'gpt-6.1-sol', input: ['text', 'image'] },
    ]
    expect(withGatewayModelInputDefaults('codex', connection('codex'), models)).toEqual(models)
    const missing = [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol', input: [] }]
    expect(
      withGatewayModelInputDefaults(
        'codex',
        { ...connection('codex'), defaultInput: ['text'] },
        missing,
      ),
    ).toEqual(missing)
  })

  it('refreshes text defaults only for a catalog identified as an unchanged automatic import', () => {
    const models = [
      { id: 'gpt-6.1-sol', input: ['text'], custom: { nested: [true, null] } },
      { id: 'gpt-6-astra', input: [] },
      { id: 'gpt-future', input: ['text'] },
    ]
    expect(
      withGatewayModelInputDefaults('codex', connection('codex'), models, {
        refreshAutomaticInputs: true,
      }),
    ).toEqual([
      { ...models[0], input: ['text', 'image'] },
      { ...models[1], input: ['text', 'image'] },
      models[2],
    ])
    expect(withGatewayModelInputDefaults('codex', connection('codex'), models)).toEqual([
      models[0],
      { ...models[1], input: ['text', 'image'] },
      models[2],
    ])
    expect(
      withGatewayModelInputDefaults(
        'codex',
        { ...connection('codex'), defaultInput: ['text'] },
        models,
        { refreshAutomaticInputs: true },
      ),
    ).toEqual(models)
  })

  it.each([
    { baseURL: 'https://tenant.invalid/v1' },
    { apiKeyEnv: 'CUSTOM_REF' },
    { api: 'openai-completions' },
  ])('preserves a custom connection: %j', (custom) => {
    const models = [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol', input: [] }]
    expect(
      withGatewayModelInputDefaults('codex', { ...connection('codex'), ...custom }, models),
    ).toEqual(models)
  })

  it('resolves completed empty inputs through the official Config and registered model runtime', async () => {
    const provider = 'opl-gateway-openai'
    const raw = {
      ...connection('codex'),
      models: [
        { id: 'gpt-6.1-sol', input: [] },
        { id: 'gpt-6-astra', input: ['text'] },
        { id: 'gpt-custom', input: [] },
      ],
    }
    const parsed = PiAi.Config({ providers: { [provider]: raw } }).providers.get()[provider]!
    expect(parsed.models[0]!.input).toEqual([])
    expect(parsed.defaultInput).toEqual(['text'])
    const models = withGatewayModelInputDefaults('codex', raw, raw.models)
    const fetch = vi.fn(async () => {
      throw Error('Metadata test forbids network')
    })
    const resolve = vi.fn(async () => {
      throw Error('Metadata test forbids credential reads')
    })
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    ctx.provide(
      'launchEnvironment',
      createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
    )
    ctx.provide('credentials', { resolve })
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(PiAi, {
        providers: {
          [provider]: { ...raw, models },
          'opl-fixture-undeclared': raw,
        },
      })
      expect(
        (await ctx.llm.resolveModelInfo('opl-fixture-undeclared', 'gpt-6.1-sol')).inputModalities,
      ).toEqual(['text'])
      expect((await ctx.llm.resolveModelInfo(provider, 'gpt-6.1-sol')).inputModalities).toEqual([
        'text',
        'image',
      ])
      expect((await ctx.llm.resolveModelInfo(provider, 'gpt-6-astra')).inputModalities).toEqual([
        'text',
      ])
      expect((await ctx.llm.resolveModelInfo(provider, 'gpt-custom')).inputModalities).toEqual([
        'text',
      ])
      expect(fetch).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    { defaultInput: ['text', 'image'], imageInput: true },
    { defaultInput: ['text'], imageInput: false },
  ])(
    'uses effective route inputs for execution when a model input is empty: $defaultInput',
    async ({ defaultInput, imageInput }) => {
      const provider = 'opl-gateway-openai'
      const model = 'gpt-6.1-sol'
      const providers = {
        [provider]: {
          ...connection('codex'),
          defaultInput,
          models: [{ id: model, input: [] }],
        },
      }
      const fetch = vi.fn(async () => {
        throw Error('Metadata test forbids network')
      })
      const resolve = vi.fn(async () => {
        throw Error('Metadata test forbids credential reads')
      })
      vi.stubGlobal('fetch', fetch)
      const ctx = new Context()
      ctx.provide(
        'launchEnvironment',
        createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
      )
      ctx.provide('credentials', { resolve })
      ctx.provide('settings', {
        describe: () => [
          { ns: 'opl-suite', value: {} },
          { ns: 'llm-pi-ai', value: { providers } },
        ],
      })
      try {
        await ctx.plugin(LlmRuntime)
        await ctx.plugin(PiAi, { providers })
        expect((await ctx.llm.resolveModelInfo(provider, model)).inputModalities).toEqual(
          defaultInput,
        )
        expect(
          (
            await resolveGatewayExecution(
              ctx,
              { provider: 'opl-gateway', model: `codex::${model}` },
              async () => 'fixture-key',
            )
          ).imageInput,
        ).toBe(imageInput)
        expect(providers[provider].models[0]!.input).toEqual([])
        expect(fetch).not.toHaveBeenCalled()
        expect(resolve).not.toHaveBeenCalled()
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('exposes seeded image metadata through the actual adapter and external route without auth or network', async () => {
    const fetch = vi.fn(async () => {
      throw Error('Metadata test forbids network')
    })
    const resolve = vi.fn(async () => {
      throw Error('Metadata test forbids credential reads')
    })
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    ctx.provide(
      'launchEnvironment',
      createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
    )
    ctx.provide('credentials', { resolve })
    ctx.provide('settings', {
      describe: () => [
        { ns: 'opl-suite', value: { gatewayGroups: { kiro: true } } },
        { ns: 'llm-pi-ai', value: { providers: profiles } },
      ],
    })
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(PiAi, { providers: profiles })
      for (const entry of GATEWAY_MODEL_INPUT_DEFAULTS) {
        const definition = GATEWAY_GROUPS.find((group) => group.id === entry.group)!
        if (
          !profiles[definition.provider]?.models.some((model: ModelDraft) => model.id === entry.id)
        )
          continue
        expect(
          (await ctx.llm.resolveModelInfo(definition.provider, entry.id)).inputModalities,
        ).toEqual(entry.input)
        expect(
          (
            await resolveGatewayExecution(
              ctx,
              { provider: 'opl-gateway', model: `${entry.group}::${entry.id}` },
              async () => 'fixture-key',
            )
          ).imageInput,
        ).toBe(true)
      }
      expect(fetch).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(GATEWAY_MODEL_INPUT_DEFAULTS)(
    'serializes a fixture image in the installed SDK for $group/$id before transport',
    async (entry) => {
      const source = catalogModel(entry)!
      const provider = `opl-fixture-${entry.group}`
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII='
      const payloads: unknown[] = []
      const fetch = vi.fn(async () => {
        throw Error('Image serialization test forbids network')
      })
      vi.stubGlobal('fetch', fetch)
      const request: PiContext = {
        messages: [
          {
            role: 'user',
            timestamp: 0,
            content: [
              { type: 'text', text: 'fixture' },
              { type: 'image', data: png, mimeType: 'image/png' },
            ],
          },
        ],
      }
      const options: SimpleStreamOptions = {
        apiKey: 'fixture-key',
        fetch,
        onPayload: (payload) => {
          payloads.push(payload)
          throw Error('Fixture stops after serialization')
        },
      }
      const stream =
        entry.group === 'gemini'
          ? streamCompletions(
              {
                ...source,
                api: 'openai-completions',
                provider,
                baseUrl: 'https://fixture.invalid/v1',
              },
              request,
              options,
            )
          : source.api === 'anthropic-messages'
            ? streamMessages(
                { ...source, provider, baseUrl: 'https://fixture.invalid' },
                request,
                options,
              )
            : streamResponses(
                { ...source, provider, baseUrl: 'https://fixture.invalid/v1' },
                request,
                options,
              )
      const events = []
      for await (const event of stream) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'error' })
      expect(payloads).toHaveLength(1)
      const image =
        entry.group === 'gemini'
          ? { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }
          : source.api === 'anthropic-messages'
            ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
            : { type: 'input_image', image_url: `data:image/png;base64,${png}` }
      const content = expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([expect.objectContaining(image)]),
        }),
      ])
      expect(payloads[0]).toMatchObject(
        entry.group === 'gemini' || source.api === 'anthropic-messages'
          ? { messages: content }
          : { input: content },
      )
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})
