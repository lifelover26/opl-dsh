import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  miniMaxAccountLoginState,
  minimaxAccountBuildEnv,
  minimaxAccountDataDir,
  minimaxAccountStateLocation,
  readMiniMaxAccountLoginState,
  readMiniMaxAccountState,
} from '../../src/execution/host/minimax-account-state.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'opl-minimax-state-'))
  temporary.push(directory)
  return directory
}

function state(
  region: 'cn' | 'en',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    status: 'authenticated',
    storeKind: 'file',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    buildEnv: 'prod',
    region,
    generation: 7,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  }
}

async function writeState(
  directory: string,
  region: 'cn' | 'en',
  value: unknown,
  buildEnv = 'prod',
): Promise<void> {
  const path = join(directory, 'auth', buildEnv, region, 'mcode-public')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'auth-state.json'), JSON.stringify(value), 'utf8')
}

describe('official MiniMax metadata namespace', () => {
  it('uses the production build env and the official internal region name', () => {
    const root = resolve('C:/opl-data')
    expect(
      minimaxAccountStateLocation('global', {
        env: { MINIMAX_DATA_DIR: 'C:/opl-data' },
      }),
    ).toEqual({
      dataDir: root,
      buildEnv: 'prod',
      internalRegion: 'en',
      statePath: join(root, 'auth', 'prod', 'en', 'mcode-public', 'auth-state.json'),
    })
    expect(
      minimaxAccountStateLocation('cn', {
        env: { MINIMAX_DATA_DIR: 'C:/opl-data' },
      }).statePath,
    ).toBe(join(root, 'auth', 'prod', 'cn', 'mcode-public', 'auth-state.json'))
  })

  it('prefers MINIMAX_DATA_DIR over MAVIS_DATA_DIR and never scans another region', () => {
    expect(minimaxAccountDataDir({ MINIMAX_DATA_DIR: ' C:/one ', MAVIS_DATA_DIR: 'C:/two' })).toBe(
      resolve('C:/one'),
    )
    expect(minimaxAccountDataDir({ MAVIS_DATA_DIR: 'C:/two' })).toBe(resolve('C:/two'))
    expect(minimaxAccountDataDir({ USERPROFILE: 'C:/home' })).toBe(resolve('C:/home', '.minimax'))
    expect(
      minimaxAccountStateLocation('cn', {
        env: { MINIMAX_DATA_DIR: 'C:/one', MAVIS_DATA_DIR: 'C:/two' },
      }).statePath,
    ).not.toContain(`${join('auth', 'en')}`)
  })

  it('honors the official --profile data-directory suffix when no override is set', () => {
    expect(minimaxAccountDataDir({ USERPROFILE: 'C:/home' }, ['--profile', 'work'])).toBe(
      resolve('C:/home', '.minimax-work'),
    )
    expect(minimaxAccountDataDir({ USERPROFILE: 'C:/home' }, ['--profile=work'])).toBe(
      resolve('C:/home', '.minimax-work'),
    )
    expect(minimaxAccountDataDir({ USERPROFILE: 'C:/home' }, ['--profile', ' '])).toBe(
      resolve('C:/home', '.minimax'),
    )
    expect(
      minimaxAccountDataDir({ USERPROFILE: 'C:/home', MINIMAX_DATA_DIR: 'C:/override' }, [
        '--profile',
        'work',
      ]),
    ).toBe(resolve('C:/override'))
  })

  it('treats a production build as prod and leaves --env ambiguous', () => {
    expect(minimaxAccountBuildEnv()).toBe('prod')
    expect(minimaxAccountBuildEnv(['--lane', 'production'])).toBe('prod')
    // A production package rejects --env; only an internal package honors it. The prefix
    // alone cannot prove which package is selected, so no namespace is asserted.
    expect(minimaxAccountBuildEnv(['--env', 'test'])).toBeUndefined()
    expect(minimaxAccountBuildEnv(['--env=pre'])).toBeUndefined()
    expect(minimaxAccountBuildEnv(['--env', 'staging'])).toBeUndefined()
    expect(minimaxAccountBuildEnv(['--env', 'prod'])).toBeUndefined()
    expect(minimaxAccountBuildEnv(['--env', 'unsupported'])).toBeUndefined()
  })
})

describe('official MiniMax login state', () => {
  it('reports unknown when --env makes the build namespace ambiguous', async () => {
    const directory = await dataDir()
    // A valid prod account must not be reported as signed-out through a guessed staging path.
    await writeState(directory, 'cn', state('cn'))
    const read = await readMiniMaxAccountLoginState('cn', {
      env: { MINIMAX_DATA_DIR: directory },
      prefix: ['--env', 'staging'],
    })
    expect(read.state).toEqual({ kind: 'unknown', reason: 'namespace' })
    expect(read.loginState).toBe('unknown')
    expect(read.location).toBeUndefined()
  })

  it('can read an explicitly known non-production namespace', async () => {
    const directory = await dataDir()
    await writeState(directory, 'cn', state('cn', { buildEnv: 'staging' }), 'staging')
    const read = await readMiniMaxAccountLoginState('cn', {
      env: { MINIMAX_DATA_DIR: directory },
      buildEnv: 'staging',
    })
    expect(read.loginState).toBe('signed-in')
  })

  it('reports a missing metadata file as signed out', async () => {
    const directory = await dataDir()
    const location = minimaxAccountStateLocation('cn', { env: { MINIMAX_DATA_DIR: directory } })
    expect(await readMiniMaxAccountState(location)).toEqual({ kind: 'missing' })
    expect(miniMaxAccountLoginState({ kind: 'missing' })).toBe('signed-out')
  })

  it('does not treat a leftover auth.json as a login', async () => {
    const directory = await dataDir()
    await writeState(directory, 'cn', state('cn', { status: 'anonymous', expiresAtMs: undefined }))
    await writeFile(
      join(directory, 'auth', 'prod', 'cn', 'mcode-public', 'auth.json'),
      JSON.stringify({ accessToken: 'must-not-be-read', refreshToken: 'also-secret' }),
      'utf8',
    )
    const read = await readMiniMaxAccountLoginState('cn', {
      env: { MINIMAX_DATA_DIR: directory },
    })
    expect(read.loginState).toBe('signed-out')
    expect(JSON.stringify(read)).not.toContain('must-not-be-read')
    expect(JSON.stringify(read)).not.toContain('also-secret')
  })

  it('maps the official credential states without exposing authorization data', async () => {
    const directory = await dataDir()
    const authorization = {
      leaseId: 'lease',
      leaseExpiresAtMs: Date.now() + 600_000,
      userCode: 'SECRET-CODE',
      verificationUri: 'https://example.invalid/SECRET-URL',
      verificationUriComplete: 'https://example.invalid/SECRET-URL?code=SECRET-CODE',
    }
    await writeState(
      directory,
      'cn',
      state('cn', { status: 'authorizing', expiresAtMs: undefined, authorization }),
    )
    const read = await readMiniMaxAccountLoginState('cn', {
      env: { MINIMAX_DATA_DIR: directory },
    })
    expect(read.loginState).toBe('signed-out')
    expect(JSON.stringify(read)).not.toContain('SECRET')
    expect(read.state).toEqual({ kind: 'present', status: 'authorizing' })
  })

  it.each([
    ['authenticated', 'signed-in'],
    ['refreshing', 'signed-in'],
    ['expired', 'signed-in'],
    ['scope_upgrade_required', 'signed-in'],
    ['logging_out', 'signing-out'],
    ['logout_pending', 'signing-out'],
    ['anonymous', 'signed-out'],
    ['authorizing', 'signed-out'],
    ['error', 'unknown'],
  ] as const)('maps %s to %s', async (status, expected) => {
    const directory = await dataDir()
    await writeState(
      directory,
      'en',
      state('en', {
        status,
        ...(status === 'authorizing' ||
        status === 'anonymous' ||
        status === 'logging_out' ||
        status === 'logout_pending' ||
        status === 'error'
          ? { expiresAtMs: undefined }
          : {}),
      }),
    )
    const read = await readMiniMaxAccountLoginState('global', {
      env: { MINIMAX_DATA_DIR: directory },
    })
    expect(read.loginState).toBe(expected)
  })

  it('keeps an expired access token as a stored login because the CLI refreshes it', async () => {
    const directory = await dataDir()
    await writeState(directory, 'cn', state('cn', { status: 'authenticated', expiresAtMs: 1 }))
    const read = await readMiniMaxAccountLoginState('cn', {
      env: { MINIMAX_DATA_DIR: directory },
    })
    expect(read.state).toEqual({ kind: 'present', status: 'authenticated', expiresAtMs: 1 })
    expect(read.loginState).toBe('signed-in')
  })

  it.each([
    ['invalid JSON', '{not json'],
    ['an unsupported schema', JSON.stringify(state('cn', { schemaVersion: 3 }))],
    ['an unknown status', JSON.stringify(state('cn', { status: 'future-state' }))],
    ['a region mismatch', JSON.stringify(state('en'))],
    ['a build env mismatch', JSON.stringify(state('cn', { buildEnv: 'staging' }))],
    ['a client mismatch', JSON.stringify(state('cn', { clientId: 'another-client' }))],
    ['an audience mismatch', JSON.stringify(state('cn', { audience: 'another-audience' }))],
    ['a malformed expiry', JSON.stringify(state('cn', { expiresAtMs: 'soon' }))],
  ])('reports %s as unknown instead of guessing', async (_label, text) => {
    const directory = await dataDir()
    const path = join(directory, 'auth', 'prod', 'cn', 'mcode-public')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'auth-state.json'), text, 'utf8')
    const read = await readMiniMaxAccountLoginState('cn', {
      env: { MINIMAX_DATA_DIR: directory },
    })
    expect(read.loginState).toBe('unknown')
    expect(read.state.kind).toBe('unknown')
  })
})
