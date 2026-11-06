import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { gatewayDiscoveryBaseURL } from '../../src/gateway/host/protocol.ts'
import { discoverGatewayModels } from '../../src/gateway/host/model-settings.ts'

afterEach(() => vi.unstubAllGlobals())

const patch = parse(await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
})
const profiles = patch.find((item: { id?: string }) => item.id === 'llm-pi-ai').config.providers
function response() {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'fixture',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-5-5',
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
async function runtime(provider: string, override: Record<string, unknown> = {}) {
  const ctx = new Context()
  const profile = { ...profiles[provider], ...override }
  ctx.provide(
    'launchEnvironment',
    createLaunchEnvironmentSnapshot([
      { source: 'process', values: { [profile.apiKeyEnv]: 'fixture-key' } },
    ]),
  )
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { [provider]: profile } })
  return ctx
}

describe('official SDK protocol requests', () => {
  it.each(['aws', 'kiro'])(
    'sends %s Opus requests once to /v1/messages with declared adaptive effort mappings',
    async (group) => {
      const provider = `opl-gateway-${group}`
      const requests: { url: string; body: Record<string, any>; headers: Headers }[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init)
          requests.push({
            url: request.url,
            body: JSON.parse(await request.text()),
            headers: request.headers,
          })
          return response()
        }),
      )
      const ctx = await runtime(provider)
      try {
        const info = await ctx.llm.resolveModelInfo(provider, 'claude-opus-5-5')
        const efforts = Object.keys(profiles[provider].models[0].reasoningEfforts)
        expect(info.reasoning?.efforts.map((effort) => effort.id)).toEqual(efforts)
        expect(info.inputModalities).toEqual(['text', 'image'])
        for (const effort of info.reasoning!.efforts) {
          const chunks = []
          for await (const chunk of ctx.llm.stream({
            provider,
            model: 'claude-opus-5-5',
            reasoningEffort: effort.id,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
          }))
            chunks.push(chunk)
          expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
          const request = requests.at(-1)!
          const url = new URL(request.url)
          expect(url.origin).toBe('https://gateway.medopl.com')
          expect(url.pathname).toBe('/v1/messages')
          expect(request.body.thinking).toMatchObject({ type: 'adaptive' })
          expect(request.body.thinking).not.toHaveProperty('budget_tokens')
          expect(request.body.output_config).toEqual({
            effort: profiles[provider].models[0].reasoningEfforts[effort.id],
          })
          expect(request.headers.get('x-api-key')).toBe('fixture-key')
        }
        expect(requests).toHaveLength(efforts.length)
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('uses OpenAI bearer listing at the effective Anthropic endpoint without inference', async () => {
    const requests: Request[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return Response.json({ data: [{ id: 'claude-opus-5-5' }] })
      }),
    )
    const profile = {
      ...profiles['opl-gateway-aws'],
      baseURL: 'https://tenant.invalid/gateway',
      apiKeyEnv: 'CUSTOM_KEY',
      headers: { 'x-tenant': 'fixture-tenant' },
    }
    const ctx = await runtime('opl-gateway-aws', profile)
    ctx.provide('settings', {
      describe: () => [
        { ns: 'opl-suite', value: { gatewayGroups: { aws: true } } },
        { ns: 'llm-pi-ai', value: { providers: { 'opl-gateway-aws': profile } } },
      ],
    })
    ctx.provide('credentials', {
      resolve: async (ref: string) =>
        ref === 'CUSTOM_KEY' ? { value: 'custom-fixture' } : undefined,
    })
    try {
      const candidates = await discoverGatewayModels(ctx, { group: 'aws' })
      expect(candidates).toHaveLength(1)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe('https://tenant.invalid/gateway/v1/models')
      expect(requests[0]!.headers.get('authorization')).toBe('Bearer custom-fixture')
      expect(requests[0]!.headers.get('x-api-key')).toBeNull()
      expect(requests[0]!.headers.get('x-tenant')).toBe('fixture-tenant')
      expect(requests[0]!.method).toBe('GET')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([401, 503])(
    'classifies the installed directory adapter HTTP %i failure without exposing the body',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('private body fixture-private', { status })),
      )
      const ctx = await runtime('opl-gateway-aws')
      ctx.provide('settings', {
        describe: () => [
          { ns: 'opl-suite', value: {} },
          {
            ns: 'llm-pi-ai',
            value: { providers: { 'opl-gateway-aws': profiles['opl-gateway-aws'] } },
          },
        ],
      })
      ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-key' }) })
      try {
        const error = await discoverGatewayModels(ctx, { group: 'aws' }).catch(
          (error: unknown) => error,
        )
        expect(error).toMatchObject({
          diagnostic: { code: status === 401 ? 'authentication' : 'http', status },
        })
        expect(JSON.stringify(error)).not.toContain('fixture-private')
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )
})

it('retains custom deployment path segments and refuses credentials in discovery URLs', () => {
  expect(gatewayDiscoveryBaseURL('https://tenant.invalid/edge', 'anthropic-messages')).toBe(
    'https://tenant.invalid/edge/v1',
  )
  expect(gatewayDiscoveryBaseURL('https://tenant.invalid/edge/v1/', 'anthropic-messages')).toBe(
    'https://tenant.invalid/edge/v1',
  )
  expect(() =>
    gatewayDiscoveryBaseURL('https://name:secret@tenant.invalid/v1', 'openai-responses'),
  ).toThrow()
  expect(() => gatewayDiscoveryBaseURL('https://tenant.invalid/v1', 'unsupported')).toThrow()
})
