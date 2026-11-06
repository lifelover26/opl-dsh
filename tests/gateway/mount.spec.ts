/**
 * What this plugin contributes to a composition.
 *
 * Two facts matter and they pull in opposite directions: the route must be
 * live (so the composer can pick its model and first-run readiness is
 * satisfied), and it appears in the native Models page directory as the
 * first-class OPL provider. Account authentication remains on the OPL page;
 * the native page is the single model configuration surface.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TYPERT } from '../../src/generated/host.mjs'
import { TYPERT_REMOTE } from '../../src/generated/remote.mjs'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { LlmError } from '@deepseek-ai/dsh-llm'
import * as OplGateway from '../../src/gateway/host/index.ts'
import { GatewayPasswordStore } from '../../src/gateway/host/remembered-login.ts'
import { OplGatewayAccountService, gatewayKeyName } from '../../src/gateway/host/account-service.ts'
import {
  GatewayControlClient,
  GatewayControlError,
} from '../../src/gateway/host/gateway-control.ts'
import type { GatewayManagedKey } from '../../src/gateway/host/gateway-control.ts'

let home = ''
let stateRoot = ''
const previousStateRoot = process.env.OPL_GATEWAY_STATE_ROOT
const previousDshHome = process.env.DSH_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-opl-mount-'))
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-opl-state-'))
  // Hermetic: the plugin reads OPL's own state directory unless told otherwise,
  // and a unit test must not depend on the developer's gateway account.
  process.env.OPL_GATEWAY_STATE_ROOT = stateRoot
  // The account service writes its cache beside the Harness home; point that at
  // the scratch directory so a test never touches the developer's own state.
  process.env.DSH_HOME = home
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (previousStateRoot === undefined) delete process.env.OPL_GATEWAY_STATE_ROOT
  else process.env.OPL_GATEWAY_STATE_ROOT = previousStateRoot
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(home, { recursive: true, force: true })
  await rm(stateRoot, { recursive: true, force: true })
})

/** A context with the seams the account service needs, and no mounted plugin. */
async function seams(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
  return ctx
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
  await ctx.plugin(OplGateway, {})
  return ctx
}

describe('OPL Gateway composition', () => {
  it('routes native search with the Codex key and keeps page fetch independent', async () => {
    const ctx = await mount()
    await ctx.plugin(WebRuntime, { searchProvider: 'opl-gateway', fetchProvider: 'http' })
    await ctx.credentials.set(credentialRef('OPL_GATEWAY_CODEX_API_KEY'), 'search-group-key')
    const fetchPage = vi.fn(async () => ({
      url: 'https://example.org',
      statusCode: 200,
      body: { kind: 'text' as const, content: 'official fetch' },
      truncated: false,
    }))
    ctx.web.registerFetchProvider({ id: 'http', available: () => true, fetch: fetchPage })
    const fetchMock = vi.fn(
      async () =>
        new Response(
          'data: ' +
            JSON.stringify({
              type: 'response.output_text.annotation.added',
              output_index: 0,
              annotation: { type: 'url_citation', url: 'https://example.org', title: 'Example' },
            }) +
            '\n\n',
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect((await ctx.web.search({ query: 'Example' })).sources[0]?.url).toBe(
        'https://example.org',
      )
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://gateway.medopl.com/v1/responses')
      expect(JSON.parse(String(init.body)).model).toBe('gpt-6.1-sol')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer search-group-key')
      expect((await ctx.web.fetch({ url: 'https://example.org' })).body).toEqual({
        kind: 'text',
        content: 'official fetch',
      })
      expect(fetchPage).toHaveBeenCalledOnce()
      expect(fetchMock).toHaveBeenCalledOnce()
      fetchMock.mockImplementationOnce(
        async () => new Response('service unavailable', { status: 503 }),
      )
      await expect(ctx.web.search({ query: 'Unavailable search' })).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries account capability fields across both Host and Client codecs', () => {
    const status = {
      phase: 'connected',
      endpoint: 'https://gateway.test/v1',
      keyReady: true,
      codexKeyReady: true,
      grokKeyReady: true,
      harnessError: 'unavailable',
      activeChannel: 'grok',
    }
    for (const allDescriptors of [TYPERT.invocations, TYPERT_REMOTE.descriptors]) {
      const descriptors = allDescriptors.filter((item) => item.namespace === 'oplGatewayAccount')
      expect(descriptors.map((item) => item.namespace)).toEqual(Array(7).fill('oplGatewayAccount'))
      const codec = descriptors.find((item) => item.method === 'status')!.result.create()
      expect(codec.parse(status)).toMatchObject(status)
    }
  })

  it('does not treat another OPL app account as this installation’s login', async () => {
    await writeFile(
      join(stateRoot, 'account.json'),
      JSON.stringify({
        surface_kind: 'opl_gateway_account_state.v1',
        status: 'connected',
        snapshot: { email: 'previous@example.test' },
      }),
      { mode: 0o600 },
    )
    const ctx = await mount()
    const status = await ctx.get('oplGatewayAccount')?.status()
    expect(status).toMatchObject({ phase: 'signed-out', keyReady: false })
    expect(status?.account).toBeUndefined()
    expect(status?.error).toBeUndefined()
    expect(status?.source).toBeUndefined()
  })

  it('registers the route so its model is selectable', async () => {
    const ctx = await mount()
    expect(ctx.llm.listProviders()).toContainEqual({ id: 'opl-gateway', name: 'OPL Gateway' })
  })

  it('is declared in the native Models page directory', async () => {
    const ctx = await mount()
    expect(ctx.llm.listConfigurableProviders()).toContainEqual(
      expect.objectContaining({
        provider: 'opl-gateway',
        displayName: 'OPL Gateway',
        settingsNs: 'opl-suite',
        settingsPath: ['gateway'],
      }),
    )
  })

  it('provides the account surface the settings page drives', async () => {
    const ctx = await mount()
    const account = ctx.get('oplGatewayAccount')
    expect(account).toBeDefined()
    expect(await account?.status()).toMatchObject({ phase: 'signed-out', keyReady: false })
    expect(await account?.status()).not.toHaveProperty('models')
  })
})

/**
 * The account flow against a scripted gateway.
 *
 * This is the case that matters for a machine with nothing else installed: the
 * plugin must take an operator from "no account" to "working key" on its own,
 * because the gateway is a service rather than a local program.
 */
describe('account flow without any local OPL installation', () => {
  /** A scripted gateway recording what the plugin asked it to do. */
  function gateway(
    options: {
      existingKeys?: GatewayManagedKey[]
      withKey?: boolean
      groups?: { id: string; label: string }[]
    } = {},
  ) {
    const calls: string[] = []
    const keys: GatewayManagedKey[] = options.existingKeys ?? []
    const control: GatewayControlClient = Object.assign(new GatewayControlClient(), {
      login: async (email: string, password: string) => {
        calls.push(`login:${email}`)
        // A real instance, because the service branches on the type: a stub
        // error would exercise the "unexpected" path instead of the refusal.
        if (password !== 'right')
          throw new GatewayControlError(
            'invalid_credentials',
            'The account email or password is incorrect',
            401,
          )
        return { accessToken: 'access', refreshToken: 'refresh-1' }
      },
      refreshSession: async (token: string) => {
        calls.push(`refresh:${token}`)
        return { accessToken: 'access-2', refreshToken: 'refresh-2' }
      },
      profile: async () => {
        calls.push('profile')
        return {
          userId: '7',
          displayName: 'Person',
          email: 'person@example.test',
          status: 'active',
          balanceAmount: 12.5,
          balanceCurrency: 'USD',
        }
      },
      usage: async () => ({
        todayTokens: 1024,
        totalTokens: 4096,
        todayCost: 0.25,
        totalCost: 3,
        currency: 'USD',
      }),
      groups: async () =>
        options.groups ?? [
          { id: '3', label: 'Codex' },
          { id: '22', label: 'DeepSeek' },
        ],
      keys: async () => {
        calls.push('keys')
        return keys
      },
      createKey: async (_token: string, name: string, groupId: string | null) => {
        calls.push(`createKey:${name}:${String(groupId)}`)
        const created: GatewayManagedKey = {
          id: groupId === '22' ? '5' : '6',
          name,
          key: 'sk-issued-' + groupId,
          status: 'active',
          groupId,
          raw: { id: 5, name, status: 'active' },
        }
        if (options.withKey !== false) keys.push(created)
        return created
      },
      setKeyStatus: async (_token: string, key: GatewayManagedKey, status: string) => {
        calls.push(`setKeyStatus:${key.id}:${status}`)
      },
    })
    return { control, calls, keys }
  }

  async function service(control: GatewayControlClient) {
    // A bare context: the plugin itself is covered above, and mounting it would
    // register the very service this harness constructs by hand.
    const ctx = await seams()
    const credentials = ctx.get('credentials')
    expect(credentials).toBeDefined()
    return {
      account: new OplGatewayAccountService(ctx, {
        credentialRef: () => (ctx.get('llm'), 'OPL_GATEWAY_DEEPSEEK_API_KEY' as never),
        endpoint: () => 'https://gateway.example/v1',
        control,
      }),
      credentials: credentials!,
    }
  }

  it('saves a password only after successful explicit opt-in', async () => {
    const save = vi.spyOn(GatewayPasswordStore.prototype, 'save').mockResolvedValue()
    const clear = vi.spyOn(GatewayPasswordStore.prototype, 'clear').mockResolvedValue()
    const { account } = await service(gateway().control)
    await expect(account.signIn('person@example.test', 'wrong', true)).rejects.toThrow()
    expect(save).not.toHaveBeenCalled()
    await account.signIn('person@example.test', 'right', true)
    expect(save).toHaveBeenCalledExactlyOnceWith('person@example.test', 'right')
    await account.signIn('person@example.test', 'right', false)
    expect(clear).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('preserves a successful login when optional password storage fails', async () => {
    vi.spyOn(GatewayPasswordStore.prototype, 'save').mockRejectedValue(Error('keyring unavailable'))
    const { account } = await service(gateway().control)
    expect(await account.signIn('person@example.test', 'right', true)).toMatchObject({
      passwordSaveFailed: true,
      status: { phase: 'connected' },
    })
  })

  it('uses a remembered password only on explicit sign-in and forgets without logging out', async () => {
    const password = vi.spyOn(GatewayPasswordStore.prototype, 'password').mockResolvedValue('right')
    const clear = vi.spyOn(GatewayPasswordStore.prototype, 'clear').mockResolvedValue()
    const { control, calls } = gateway()
    const { account } = await service(control)
    expect(password).not.toHaveBeenCalled()
    await account.signInRemembered('person@example.test')
    expect(password).toHaveBeenCalledExactlyOnceWith('person@example.test')
    expect(calls.filter((x) => x.startsWith('login:'))).toHaveLength(1)
    await account.forgetPassword()
    expect(clear).toHaveBeenCalledOnce()
    expect((await account.status()).phase).toBe('connected')
  })

  it('takes a fresh machine from no account to a working key', async () => {
    const { control, calls } = gateway()
    const { account, credentials } = await service(control)

    expect(await account.status()).toMatchObject({ phase: 'signed-out', keyReady: false })

    const result = await account.signIn('person@example.test', 'right')
    expect(result.createdKey).toBe(true)
    // The key the gateway issued becomes the one the adapter resolves, and the
    // session is kept so a restart does not need another sign-in.
    expect((await credentials.resolve('OPL_GATEWAY_DEEPSEEK_API_KEY' as never))?.value).toBe(
      'sk-issued-22',
    )
    expect(calls).toContain(
      'createKey:OPL DSH · ' + (await import('node:os')).hostname() + ' · DeepSeek:22',
    )
    expect(calls).toContain(
      'createKey:OPL DSH · ' + (await import('node:os')).hostname() + ' · Codex:3',
    )
    expect((await credentials.resolve('OPL_GATEWAY_CODEX_API_KEY' as never))?.value).toBe(
      'sk-issued-3',
    )
    expect(await account.status()).toMatchObject({
      phase: 'connected',
      source: 'session',
      keyReady: true,
      account: { email: 'person@example.test', balanceAmount: 12.5, todayTokens: 1024 },
    })
  })

  it('keeps sign-in usable and exposes a sanitized model-sync failure until a successful retry', async () => {
    const ctx = await seams()
    const syncModels = vi.fn(async () => {
      throw new LlmError(
        'https://private.invalid/?token=fixture-private answered 503',
        'DISCOVERY_FAILED',
      )
    })
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const account = new OplGatewayAccountService(ctx, {
      credentialRef: () => credentialRef('OPL_GATEWAY_DEEPSEEK_API_KEY'),
      endpoint: () => 'https://gateway.medopl.com/v1',
      control: gateway().control,
      syncModels,
    })
    try {
      const result = await account.signIn('person@example.test', 'right')
      expect(result.status).toMatchObject({
        phase: 'connected',
        keyReady: true,
        modelSyncError: { code: 'http', status: 503 },
      })
      expect(JSON.stringify([result.status, warning.mock.calls])).not.toContain('fixture-private')
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private.invalid')
      syncModels.mockResolvedValueOnce(undefined)
      expect((await account.refresh()).modelSyncError).toBeUndefined()
      expect((await account.signOut()).modelSyncError).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reuses the key a previous sign-in left behind instead of minting another', async () => {
    const name = gatewayKeyName()
    const existing: GatewayManagedKey = {
      id: '9',
      name,
      key: 'sk-existing',
      status: 'active',
      groupId: '22',
      raw: { id: 9, name, status: 'active' },
    }
    const { control, calls } = gateway({
      existingKeys: [
        existing,
        { ...existing, id: '10', name: gatewayKeyName('Codex'), groupId: '3' },
      ],
    })
    const { account, credentials } = await service(control)

    expect((await account.signIn('person@example.test', 'right')).createdKey).toBe(false)
    expect((await credentials.resolve('OPL_GATEWAY_DEEPSEEK_API_KEY' as never))?.value).toBe(
      'sk-existing',
    )
    expect(calls.some((call) => call.startsWith('createKey'))).toBe(false)
  })

  it('reports bad credentials without leaving a session behind', async () => {
    const { control } = gateway()
    const { account, credentials } = await service(control)

    await expect(account.signIn('person@example.test', 'wrong')).rejects.toMatchObject({
      code: 'opl-gateway/credentials',
    })
    expect(await account.status()).toMatchObject({ phase: 'unavailable' })
    expect(await credentials.resolve('OPL_GATEWAY_DEEPSEEK_API_KEY' as never)).toBeUndefined()
  })

  it('releases the key on sign-out and forgets the session', async () => {
    const { control, calls } = gateway()
    const { account, credentials } = await service(control)
    await account.signIn('person@example.test', 'right')

    expect(await account.signOut()).toMatchObject({ phase: 'signed-out', keyReady: false })
    // The key was issued to this client, so ending the session disables it
    // rather than leaving a live credential nobody holds.
    expect(calls).toContain('setKeyStatus:5:disabled')
    expect(calls).toContain('setKeyStatus:6:disabled')
    expect(await credentials.resolve('OPL_GATEWAY_CODEX_API_KEY' as never)).toBeUndefined()
    expect(await credentials.resolve('OPL_GATEWAY_DEEPSEEK_API_KEY' as never)).toBeUndefined()
  })

  it('restores a missing Codex-group credential when refreshing an existing login', async () => {
    const { control, calls } = gateway()
    const { account, credentials } = await service(control)
    await account.signIn('person@example.test', 'right')
    await credentials.unset('OPL_GATEWAY_CODEX_API_KEY' as never)
    expect((await account.refresh()).groups).toContainEqual(
      expect.objectContaining({ id: 'codex', state: 'ready' }),
    )
    expect(calls.filter((call) => call.startsWith('createKey:'))).toHaveLength(2)
    expect(await credentials.resolve('OPL_GATEWAY_CODEX_API_KEY' as never)).toMatchObject({
      value: 'sk-issued-3',
    })
  })

  it('logs in a Codex-only account and reports each group independently', async () => {
    const ctx = await seams(),
      credentials = ctx.credentials
    const { control } = gateway({ groups: [{ id: 'codex', label: 'Codex' }] })
    const account = new OplGatewayAccountService(ctx, {
      credentialRef: () => credentialRef('OPL_GATEWAY_DEEPSEEK_API_KEY'),
      endpoint: () => 'https://gateway.medopl.com/v1',
      control,
    })
    const result = await account.signIn('person@example.test', 'right')
    expect(result.status).toMatchObject({
      phase: 'connected',
      keyReady: false,
      codexKeyReady: true,
    })
    expect(result.status.groups).toContainEqual(
      expect.objectContaining({ id: 'deepseek', state: 'unauthorized' }),
    )
    expect(await credentials.resolve(credentialRef('OPL_GATEWAY_DEEPSEEK_API_KEY'))).toBeUndefined()
  })

  it('keeps the DeepSeek group usable when Codex access is unavailable', async () => {
    const { control } = gateway()
    control.groups = async () => [{ id: '22', label: 'DeepSeek' }]
    const { account } = await service(control)
    const result = await account.signIn('person@example.test', 'right')
    expect(result.status).toMatchObject({
      phase: 'connected',
      keyReady: true,
      codexKeyReady: false,
    })
    expect(result.status.groups).toContainEqual(
      expect.objectContaining({ id: 'codex', state: 'unauthorized' }),
    )
  })

  it('provisions and later releases an independent Grok group key', async () => {
    const { control, calls } = gateway({
      groups: [
        { id: '3', label: 'Codex' },
        { id: '22', label: 'DeepSeek' },
        { id: '41', label: 'Grok' },
      ],
    })
    const { account, credentials } = await service(control)
    const result = await account.signIn('person@example.test', 'right')
    expect(result.status).toMatchObject({ keyReady: true, codexKeyReady: true, grokKeyReady: true })
    expect(calls).toContain(
      'createKey:OPL DSH · ' + (await import('node:os')).hostname() + ' · Grok:41',
    )
    expect((await credentials.resolve('OPL_GATEWAY_GROK_API_KEY' as never))?.value).toBe(
      'sk-issued-41',
    )
    await account.signOut()
    expect(calls).toContain('setKeyStatus:6:disabled')
    expect(await credentials.resolve('OPL_GATEWAY_GROK_API_KEY' as never)).toBeUndefined()
  })

  it('retains the Codex-group credential after a temporary refresh failure', async () => {
    const { control } = gateway()
    const { account, credentials } = await service(control)
    await account.signIn('person@example.test', 'right')
    const listKeys = control.keys.bind(control)
    control.keys = async (token, name) => {
      if (name === gatewayKeyName('Codex'))
        throw new GatewayControlError('unavailable', 'temporary outage', 503)
      return listKeys(token, name)
    }
    expect((await account.refresh()).groups).toContainEqual(
      expect.objectContaining({ id: 'codex', state: 'error' }),
    )
    expect(await credentials.resolve('OPL_GATEWAY_CODEX_API_KEY' as never)).toMatchObject({
      value: 'sk-issued-3',
    })
  })

  it.each([
    new TypeError('fetch failed'),
    new GatewayControlError('rate_limited', 'temporary rate limit', 429),
    new GatewayControlError('gateway_unavailable', 'temporary outage', 503),
  ])('retains a restarted login after transient renewal failure: %s', async (failure) => {
    const { control, calls } = gateway()
    const { account } = await service(control)
    await account.signIn('person@example.test', 'right')
    const renew = control.refreshSession.bind(control)
    control.refreshSession = async () => {
      throw failure
    }
    const restarted = (await service(control)).account
    expect(await restarted.refresh()).toMatchObject({
      phase: 'connected',
      account: { email: 'person@example.test', stale: true },
      error: { message: failure.message },
    })
    control.refreshSession = renew
    expect(await restarted.refresh()).toMatchObject({
      phase: 'connected',
      account: { email: 'person@example.test' },
    })
    expect(calls).toContain('refresh:refresh-1')
    expect((await restarted.status()).error).toBeUndefined()
  })

  it.each([401, 403])(
    'forgets a restarted login after explicit HTTP %i refusal',
    async (status) => {
      const { control } = gateway()
      const { account } = await service(control)
      await account.signIn('person@example.test', 'right')
      control.refreshSession = async () => {
        throw new GatewayControlError('invalid_credentials', 'session refused', status)
      }
      const restarted = (await service(control)).account
      expect(await restarted.refresh()).toMatchObject({ phase: 'unavailable' })
      expect(await (await service(control)).account.status()).toMatchObject({ phase: 'signed-out' })
    },
  )

  it('renews a stored session on refresh without another sign-in', async () => {
    const { control, calls } = gateway()
    const { account } = await service(control)
    await account.signIn('person@example.test', 'right')

    // A second context over the same home and credential file is the restart
    // case: the session must come back from storage, not from memory.
    const restartedCtx = await seams()
    const restarted = new OplGatewayAccountService(restartedCtx, {
      credentialRef: () => 'OPL_GATEWAY_DEEPSEEK_API_KEY' as never,
      endpoint: () => 'https://gateway.example/v1',
      control,
    })
    expect(await restarted.refresh()).toMatchObject({
      phase: 'connected',
      account: { email: 'person@example.test' },
    })
    expect(calls).toContain('refresh:refresh-1')
  })
})
