import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ path: vi.fn() }))
vi.mock('../../src/execution/host/adapters/minimax.ts', () => ({
  minimaxCodePath: mocks.path,
}))

import {
  MiniMaxAccount,
  type MiniMaxAccountSpawn,
  type MiniMaxAccountStop,
} from '../../src/execution/host/minimax-account.ts'

const temporary: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.resetAllMocks()
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
beforeEach(() => {
  mocks.path.mockResolvedValue('C:/official/mcode.exe')
})

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn(() => true)

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('close', code, signal)
  }
}

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'opl-minimax-account-'))
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

async function writeState(directory: string, region: 'cn' | 'en', value: unknown): Promise<void> {
  const path = join(directory, 'auth', 'prod', region, 'mcode-public')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'auth-state.json'), JSON.stringify(value), 'utf8')
}

function configuration(prefix: readonly string[] = []) {
  return async () => ({ command: 'C:/official/mcode.exe', prefix })
}

function spawnReturning(child: FakeChild): MiniMaxAccountSpawn {
  return vi.fn(
    (_command: string, _args: readonly string[], _options: SpawnOptions) =>
      child as unknown as ChildProcess,
  )
}

function account(options: {
  directory: string
  spawn: MiniMaxAccountSpawn
  prefix?: readonly string[]
  stop?: MiniMaxAccountStop
  forceStop?: MiniMaxAccountStop
  now?: () => number
  loginLeaseMs?: number
  logoutTimeoutMs?: number
  stopGraceMs?: number
}) {
  return new MiniMaxAccount(configuration(options.prefix), {
    environment: () => ({ MINIMAX_DATA_DIR: options.directory }),
    spawn: options.spawn,
    ...(options.stop ? { stop: options.stop } : {}),
    ...(options.forceStop ? { forceStop: options.forceStop } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.loginLeaseMs ? { loginLeaseMs: options.loginLeaseMs } : {}),
    ...(options.logoutTimeoutMs ? { logoutTimeoutMs: options.logoutTimeoutMs } : {}),
    ...(options.stopGraceMs ? { stopGraceMs: options.stopGraceMs } : {}),
  })
}

describe('official MiniMax account seat', () => {
  it('reads each region independently without spawning a CLI', async () => {
    const directory = await dataDir()
    await writeState(directory, 'cn', state('cn'))
    await writeState(directory, 'en', state('en', { status: 'anonymous', expiresAtMs: undefined }))
    const spawn = spawnReturning(new FakeChild())
    const service = account({ directory, spawn })

    expect(await service.status('cn')).toEqual({
      installed: true,
      region: 'cn',
      loginState: 'signed-in',
      loginPending: false,
    })
    expect(await service.status('global')).toEqual({
      installed: true,
      region: 'global',
      loginState: 'signed-out',
      loginPending: false,
    })
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('reads the --profile namespace selected by the configured prefix', async () => {
    const root = await dataDir()
    const profileRoot = join(root, '.minimax-work')
    await writeState(profileRoot, 'cn', state('cn'))
    const spawn = spawnReturning(new FakeChild())
    const service = new MiniMaxAccount(configuration(['--profile', 'work']), {
      environment: () => ({ USERPROFILE: root }),
      spawn,
    })
    expect(await service.status('cn')).toMatchObject({
      installed: true,
      loginState: 'signed-in',
    })
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('reports unknown rather than a false signed-out for an ambiguous --env namespace', async () => {
    const directory = await dataDir()
    await writeState(directory, 'cn', state('cn'))
    const spawn = spawnReturning(new FakeChild())
    const service = account({ directory, spawn, prefix: ['--env', 'staging'] })
    expect(await service.status('cn')).toMatchObject({
      installed: true,
      loginState: 'unknown',
      loginPending: false,
    })
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it.each(['login', 'logout'] as const)(
    'does not assert a namespace for --env during %s',
    async (operation) => {
      const directory = await dataDir()
      await writeState(directory, 'cn', state('cn'))
      vi.useFakeTimers()
      const child = new FakeChild()
      const spawn = spawnReturning(child)
      const service = account({
        directory,
        spawn,
        prefix: ['--env', 'staging'],
        logoutTimeoutMs: 100,
      })
      const result = operation === 'login' ? service.login('cn') : service.logout('cn')
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      child.close(0)
      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toMatchObject({ loginState: 'unknown', loginPending: false })
      await service.dispose()
    },
  )

  it('does not report an installation when the official CLI is missing', async () => {
    const directory = await dataDir()
    mocks.path.mockResolvedValue(undefined)
    const spawn = spawnReturning(new FakeChild())
    const service = account({ directory, spawn })
    expect(await service.status('cn')).toEqual({
      installed: false,
      region: 'cn',
      loginState: 'signed-out',
      loginPending: false,
    })
    await expect(service.login('cn')).rejects.toThrow('安装')
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('launches only the official login with the configured prefix and region', async () => {
    const directory = await dataDir()
    await writeState(directory, 'cn', state('cn'))
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const service = account({
      directory,
      spawn,
      prefix: ['--lane', 'production'],
      now: () => 1_000_000,
    })
    const login = service.login('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn).toHaveBeenCalledWith(
      'C:/official/mcode.exe',
      ['--lane', 'production', 'login', '--region', 'cn'],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        env: { MINIMAX_DATA_DIR: directory, OPL_MCODE_AUTH_CONTROL: '1' },
      }),
    )
    expect(await service.status('cn')).toEqual({
      installed: true,
      region: 'cn',
      loginState: 'signed-in',
      loginPending: true,
      pendingRegion: 'cn',
      loginDeadline: 1_600_000,
    })
    child.close(0)
    expect(await login).toEqual({
      installed: true,
      region: 'cn',
      loginState: 'signed-in',
      loginPending: false,
    })
    await service.dispose()
  })

  it.each(['cn', 'global'] as const)(
    'passes the explicit %s region to the official login command',
    async (region) => {
      const directory = await dataDir()
      const child = new FakeChild()
      const spawn = spawnReturning(child)
      const service = account({ directory, spawn })
      const login = service.login(region)
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      expect(spawn).toHaveBeenCalledWith(
        'C:/official/mcode.exe',
        ['login', '--region', region],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'] }),
      )
      child.close(0)
      await login
      await service.dispose()
    },
  )

  it('joins the same region, refuses a different one, and discards authorization stderr', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const service = account({ directory, spawn })
    const first = service.login('cn')
    const second = service.login('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    await expect(service.login('global')).rejects.toThrow('另一个地区')
    expect(spawn).toHaveBeenCalledOnce()
    child.close(0)
    expect(await first).toMatchObject({ loginState: 'signed-out', loginPending: false })
    expect(await second).toMatchObject({ loginState: 'signed-out', loginPending: false })
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'ignore'] })
    await service.dispose()
  })

  it.each(['cn', 'global'] as const)(
    'passes the explicit %s region to the official logout command',
    async (region) => {
      const directory = await dataDir()
      await writeState(
        directory,
        region === 'global' ? 'en' : 'cn',
        state(region === 'global' ? 'en' : 'cn', {
          status: 'anonymous',
          expiresAtMs: undefined,
        }),
      )
      const child = new FakeChild()
      const spawn = spawnReturning(child)
      const service = account({ directory, spawn })
      const logout = service.logout(region)
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      expect(spawn).toHaveBeenCalledWith(
        'C:/official/mcode.exe',
        ['logout', '--region', region],
        expect.objectContaining({ stdio: 'ignore' }),
      )
      child.close(0)
      expect(await logout).toMatchObject({
        region,
        loginState: 'signed-out',
        loginPending: false,
      })
      await service.dispose()
    },
  )

  it('does not start logout while a login is pending', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const service = account({ directory, spawn })
    const login = service.login('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    await expect(service.logout('cn')).rejects.toThrow('登录')
    child.close(0)
    await login
    await service.dispose()
  })

  it('confirms CN sign-out without changing the saved Global account', async () => {
    const directory = await dataDir()
    await writeState(directory, 'cn', state('cn'))
    await writeState(directory, 'en', state('en'))
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const service = account({ directory, spawn })
    const logout = service.logout('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    await writeState(directory, 'cn', state('cn', { status: 'anonymous', expiresAtMs: undefined }))
    child.close()

    expect(await logout).toMatchObject({ region: 'cn', loginState: 'signed-out' })
    expect(await service.status('global')).toMatchObject({
      region: 'global',
      loginState: 'signed-in',
    })
    expect(spawn).toHaveBeenCalledOnce()
    await service.dispose()
  })

  it('does not start login or a second logout while logout is pending', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const service = account({ directory, spawn })
    const logout = service.logout('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    await expect(service.login('cn')).rejects.toThrow('退出')
    await expect(service.logout('cn')).rejects.toThrow('退出')
    child.close(0)
    await logout
    await service.dispose()
  })

  it('disposes an active logout and reports its real state', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const stop = vi.fn(async (process: ChildProcess) => {
      ;(process as unknown as FakeChild).close(null, 'SIGTERM')
    })
    const service = account({ directory, spawn, stop })
    const logout = service.logout('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    await service.dispose()
    expect(await logout).toMatchObject({ loginState: 'signed-out', loginPending: false })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reports a failed logout from the real metadata instead of claiming success', async () => {
    const directory = await dataDir()
    await writeState(directory, 'en', state('en'))
    const child = new FakeChild()
    const service = account({ directory, spawn: spawnReturning(child) })
    const logout = service.logout('global')
    await vi.waitFor(() => expect(mocks.path).toHaveBeenCalled())
    child.close(1)
    await expect(logout).rejects.toThrow('退出未完成')
    expect(await service.status('global')).toMatchObject({
      loginState: 'signed-in',
      loginPending: false,
    })
    await service.dispose()
  })

  it('accepts a failed logout process only when the account is actually signed out', async () => {
    const directory = await dataDir()
    await writeState(directory, 'cn', state('cn', { status: 'anonymous', expiresAtMs: undefined }))
    const child = new FakeChild()
    const service = account({ directory, spawn: spawnReturning(child) })
    const logout = service.logout('cn')
    await vi.waitFor(() => expect(mocks.path).toHaveBeenCalled())
    child.close(1)
    expect(await logout).toMatchObject({ loginState: 'signed-out' })
    await service.dispose()
  })

  it('cancels before spawning while command resolution is still pending', async () => {
    const directory = await dataDir()
    let release!: (value: { command: string; prefix: readonly string[] }) => void
    const configuration = new Promise<{ command: string; prefix: readonly string[] }>((resolve) => {
      release = resolve
    })
    const spawn = spawnReturning(new FakeChild())
    const service = new MiniMaxAccount(() => configuration, {
      environment: () => ({ MINIMAX_DATA_DIR: directory }),
      spawn,
    })
    const login = service.login('cn')
    expect(await service.cancel('cn')).toEqual({
      installed: false,
      region: 'cn',
      loginState: 'signed-out',
      loginPending: false,
    })
    // Cancellation settles the login RPC even though command resolution never completed.
    expect(await login).toMatchObject({ loginPending: false, loginState: 'signed-out' })
    release({ command: 'C:/official/mcode.exe', prefix: [] })
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('settles every same-region join when cancellation wins before spawn', async () => {
    const directory = await dataDir()
    let release!: (value: { command: string; prefix: readonly string[] }) => void
    const configuration = new Promise<{ command: string; prefix: readonly string[] }>((resolve) => {
      release = resolve
    })
    const spawn = spawnReturning(new FakeChild())
    const service = new MiniMaxAccount(() => configuration, {
      environment: () => ({ MINIMAX_DATA_DIR: directory }),
      spawn,
    })
    const first = service.login('cn')
    const second = service.login('cn')
    expect(await service.cancel('cn')).toMatchObject({ loginPending: false })
    expect(await first).toMatchObject({ loginPending: false })
    expect(await second).toMatchObject({ loginPending: false })
    release({ command: 'C:/official/mcode.exe', prefix: [] })
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('cancels during CLI discovery without spawning the login process', async () => {
    const directory = await dataDir()
    let release!: (path: string) => void
    mocks.path.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    const spawn = spawnReturning(new FakeChild())
    const service = account({ directory, spawn })
    const login = service.login('cn')
    await vi.waitFor(() => expect(mocks.path).toHaveBeenCalled())
    await service.cancel('cn')
    release('C:/official/mcode.exe')
    expect(await login).toMatchObject({ loginPending: false })
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('stops only its own child and reports a late credential commit as signed-in', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    let stop!: MiniMaxAccountStop
    stop = vi.fn(async (process: ChildProcess) => {
      await writeState(directory, 'cn', state('cn'))
      ;(process as unknown as FakeChild).close(0)
    })
    const service = account({ directory, spawn, stop })
    const login = service.login('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const cancelled = await service.cancel('cn')
    expect(cancelled).toMatchObject({ loginState: 'signed-in', loginPending: false })
    expect(await login).toMatchObject({ loginState: 'signed-in', loginPending: false })
    expect(stop).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledWith(child)
    await service.dispose()
  })

  it('leaves another region alone when cancelling', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const stop = vi.fn<MiniMaxAccountStop>()
    const service = account({ directory, spawn, stop })
    const login = service.login('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(await service.cancel('global')).toMatchObject({
      region: 'global',
      loginPending: true,
      pendingRegion: 'cn',
    })
    expect(stop).not.toHaveBeenCalled()
    child.close(0)
    await login
    await service.dispose()
  })

  it('treats a spawn failure without a live PID as terminal and drains it', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    child.pid = undefined
    const spawn = spawnReturning(child)
    const service = account({ directory, spawn })
    const login = service.login('cn')
    const check = expect(login).rejects.toThrow('无法启动')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    child.emit('error', new Error('spawn failed with secret output'))
    await check
    expect(await service.status('cn')).toMatchObject({ loginPending: false })
    await service.dispose()
  })

  it('keeps a live child when a process error is nonterminal', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const service = account({ directory, spawn })
    const login = service.login('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    child.emit('error', Error('kill EPERM'))
    await Promise.resolve()
    expect(await service.status('cn')).toMatchObject({
      loginPending: true,
      pendingRegion: 'cn',
    })
    child.close(0)
    expect(await login).toMatchObject({ loginPending: false })
    await service.dispose()
  })

  it('reports a non-zero exit as incomplete unless the account is actually signed in', async () => {
    const directory = await dataDir()
    const failed = new FakeChild()
    const service = account({ directory, spawn: spawnReturning(failed) })
    const login = service.login('cn')
    const check = expect(login).rejects.toThrow('未完成')
    await vi.waitFor(() => expect(mocks.path).toHaveBeenCalled())
    failed.close(1)
    await check
    expect(await service.status('cn')).toMatchObject({ loginPending: false })

    await writeState(directory, 'cn', state('cn'))
    const late = new FakeChild()
    const lateService = account({ directory, spawn: spawnReturning(late) })
    const lateLogin = lateService.login('cn')
    await vi.waitFor(() => expect(mocks.path).toHaveBeenCalled())
    late.close(1)
    expect(await lateLogin).toMatchObject({ loginState: 'signed-in' })
    await service.dispose()
    await lateService.dispose()
  })

  it('times out a waiting login, stops the child, and reports the real state', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const stop = vi.fn(async (process: ChildProcess) => {
      ;(process as unknown as FakeChild).close(null, 'SIGTERM')
    })
    const service = account({ directory, spawn, stop, loginLeaseMs: 25 })
    const login = service.login('cn')
    const check = expect(login).rejects.toThrow('超时')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    await check
    expect(stop).toHaveBeenCalledOnce()
    expect(await service.status('cn')).toMatchObject({ loginPending: false })
    await service.dispose()
  })

  it('reports a late success even when the lease expired first', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const stop = vi.fn(async (process: ChildProcess) => {
      await writeState(directory, 'cn', state('cn'))
      ;(process as unknown as FakeChild).close(0)
    })
    const service = account({ directory, spawn, stop, loginLeaseMs: 25 })
    expect(await service.login('cn')).toMatchObject({ loginState: 'signed-in' })
    expect(stop).toHaveBeenCalledOnce()
    await service.dispose()
  })

  it('times out before spawning when command resolution outlasts the lease', async () => {
    const directory = await dataDir()
    let release!: (value: { command: string; prefix: readonly string[] }) => void
    const configuration = new Promise<{ command: string; prefix: readonly string[] }>((resolve) => {
      release = resolve
    })
    const spawn = spawnReturning(new FakeChild())
    const service = new MiniMaxAccount(() => configuration, {
      environment: () => ({ MINIMAX_DATA_DIR: directory }),
      spawn,
      loginLeaseMs: 25,
    })
    const login = service.login('cn')
    const check = expect(login).rejects.toThrow('超时')
    // The lease rejects the RPC without waiting for the pending command resolution.
    await check
    release({ command: 'C:/official/mcode.exe', prefix: [] })
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('disposes an active login, refuses new work, and is idempotent', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const stop = vi.fn(async (process: ChildProcess) => {
      ;(process as unknown as FakeChild).close(null, 'SIGTERM')
    })
    const service = account({ directory, spawn, stop })
    const login = service.login('cn')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const disposing = service.dispose()
    await disposing
    expect(await login).toMatchObject({ loginPending: false, loginState: 'signed-out' })
    await expect(service.login('cn')).rejects.toThrow('已关闭')
    await expect(service.dispose()).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('does not spawn logout after disposal while command resolution is pending', async () => {
    const directory = await dataDir()
    let release!: (value: { command: string; prefix: readonly string[] }) => void
    const configuration = new Promise<{ command: string; prefix: readonly string[] }>((resolve) => {
      release = resolve
    })
    const spawn = spawnReturning(new FakeChild())
    const service = new MiniMaxAccount(() => configuration, {
      environment: () => ({ MINIMAX_DATA_DIR: directory }),
      spawn,
    })
    const logout = service.logout('cn')
    const check = expect(logout).rejects.toThrow('已关闭')
    await service.dispose()
    release({ command: 'C:/official/mcode.exe', prefix: [] })
    await check
    expect(spawn).not.toHaveBeenCalled()
  })

  it('disposes before a pending command resolution can spawn anything', async () => {
    const directory = await dataDir()
    let release!: (value: { command: string; prefix: readonly string[] }) => void
    const configuration = new Promise<{ command: string; prefix: readonly string[] }>((resolve) => {
      release = resolve
    })
    const spawn = spawnReturning(new FakeChild())
    const service = new MiniMaxAccount(() => configuration, {
      environment: () => ({ MINIMAX_DATA_DIR: directory }),
      spawn,
    })
    const login = service.login('cn')
    await service.dispose()
    release({ command: 'C:/official/mcode.exe', prefix: [] })
    expect(await login).toMatchObject({ loginPending: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects disposal when a live login child cannot be stopped', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const fail = async () => {
      throw Error('denied')
    }
    const service = account({ directory, spawn, stop: fail, forceStop: fail, stopGraceMs: 10 })
    const login = service.login('cn').catch(() => {})
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    await expect(service.dispose()).rejects.toThrow('无法停止')
    expect(await service.status('cn')).toMatchObject({
      loginPending: true,
      pendingRegion: 'cn',
    })
    child.close(0)
    await login
    await expect(service.dispose()).resolves.toBeUndefined()
  })

  it('rejects disposal when a live logout child cannot be stopped', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const fail = async () => {
      throw Error('denied')
    }
    const service = account({ directory, spawn, stop: fail, forceStop: fail, stopGraceMs: 10 })
    const logout = service.logout('cn').catch(() => {})
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    await expect(service.dispose()).rejects.toThrow('无法停止')
    child.close(0)
    await logout
    await expect(service.dispose()).resolves.toBeUndefined()
  })

  it('retains ownership when a stop fails and drains only after the child closes', async () => {
    const directory = await dataDir()
    const child = new FakeChild()
    const spawn = spawnReturning(child)
    const stop = vi.fn(async () => {
      throw new Error('taskkill failed')
    })
    const forceStop = vi.fn(async () => {
      throw new Error('force kill failed')
    })
    const service = account({ directory, spawn, stop, forceStop, stopGraceMs: 10 })
    const login = service.login('cn')
    const check = expect(login).rejects.toThrow('无法停止')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    await expect(service.cancel('cn')).rejects.toThrow('无法停止')
    await check
    expect(await service.status('cn')).toMatchObject({
      loginPending: true,
      pendingRegion: 'cn',
    })
    child.close(0)
    await vi.waitFor(async () => {
      expect(await service.status('cn')).toMatchObject({ loginPending: false })
    })
    await service.dispose()
  })

  it('rejects an invalid region at runtime', async () => {
    const directory = await dataDir()
    const service = account({ directory, spawn: spawnReturning(new FakeChild()) })
    await expect(service.status('moon' as never)).rejects.toThrow('地区无效')
    await service.dispose()
  })
})

it('uses the announced expiry and cooperatively cancels before forcing the process', async () => {
  const directory = await dataDir()
  const child = new FakeChild() as FakeChild & {
    stdout: EventEmitter
    stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> }
  }
  child.stdout = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: vi.fn(() => {
      child.close(1)
      return true
    }),
  })
  const spawn = spawnReturning(child)
  const stop = vi.fn()
  const service = account({ directory, spawn, stop, now: () => 1000 })
  const login = service.login('cn')
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
  child.stdout.emit('data', Buffer.from('OPL_AUTH_READY_V1\nOPL_AUTH_EXPIRES_V1 300\n'))
  expect(await service.status('cn')).toMatchObject({ loginDeadline: 301000 })
  await service.cancel('cn')
  await login
  expect(child.stdin.write).toHaveBeenCalledWith('OPL_AUTH_CANCEL_V1\n')
  expect(stop).not.toHaveBeenCalled()
  await service.dispose()
})
