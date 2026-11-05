import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniMaxAccountStatus } from '../../src/execution/contracts/minimax-account.ts'

const mocks = vi.hoisted(() => ({ path: vi.fn(), read: vi.fn() }))
vi.mock('../../src/execution/host/adapters/minimax.ts', () => ({
  minimaxCodePath: mocks.path,
}))
vi.mock('../../src/execution/host/minimax-account-state.ts', () => ({
  readMiniMaxAccountLoginState: mocks.read,
}))

import { MiniMaxAccount } from '../../src/execution/host/minimax-account.ts'
import { commandLaunch } from '../../src/execution/host/harness-registry.ts'

class Child extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('close', code, signal)
  }
}

const fixtures: { child: Child; service: MiniMaxAccount }[] = []

beforeEach(() => {
  vi.useFakeTimers()
  mocks.path.mockImplementation(async (config: { command: string }) => config.command)
  mocks.read.mockResolvedValue({ loginState: 'signed-in' })
})

afterEach(async () => {
  for (const { child, service } of fixtures.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.close()
    await service.dispose()
  }
  vi.useRealTimers()
  vi.resetAllMocks()
})

function fixture(options: { failStop?: boolean; command?: string; prefix?: string[] } = {}) {
  const child = new Child()
  const ready = Promise.withResolvers<void>()
  const configuration = {
    command: options.command ?? 'C:/fixture/mcode.exe',
    prefix: options.prefix ?? [],
  }
  const spawn = vi.fn(() => {
    ready.resolve()
    return child as unknown as ChildProcess
  })
  const stop = vi.fn(async () => {
    if (options.failStop) throw Error('stop denied')
    child.close(null, 'SIGTERM')
  })
  const forceStop = vi.fn(async () => {
    throw Error('forced stop denied')
  })
  const service = new MiniMaxAccount(async () => configuration, {
    environment: () => ({}),
    spawn,
    stop,
    forceStop,
    logoutTimeoutMs: 1000,
    stopGraceMs: 10,
  })
  fixtures.push({ child, service })
  return { child, service, spawn, stop, forceStop, ready: ready.promise, configuration }
}

describe('MiniMax logout confirmation', () => {
  it('waits for pending metadata to become signed-out and keeps the reservation meanwhile', async () => {
    let loginState: MiniMaxAccountStatus['loginState'] = 'signing-out'
    mocks.read.mockImplementation(async () => ({ loginState }))
    const { service, child, ready } = fixture()
    const logout = service.logout('cn')
    await ready
    child.close()
    await vi.advanceTimersByTimeAsync(0)

    await expect(service.login('cn')).rejects.toThrow('退出')
    await expect(service.logout('global')).rejects.toThrow('退出')
    expect(await service.status('cn')).toMatchObject({ loginState: 'signing-out' })

    loginState = 'signed-out'
    await vi.advanceTimersByTimeAsync(250)
    expect(await logout).toMatchObject({ region: 'cn', loginState: 'signed-out' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['signed-in', 'signing-out', 'unknown'] as const)(
    'returns %s after the existing timeout without inventing success',
    async (loginState) => {
      mocks.read.mockResolvedValue({ loginState })
      const { service, child, ready } = fixture()
      let settled = false
      const logout = service.logout('cn').then((status) => {
        settled = true
        return status
      })
      await ready
      child.close()
      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await logout).toMatchObject({ region: 'cn', loginState })
      expect(mocks.read.mock.calls.length).toBeGreaterThan(1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('shares the process timeout with post-exit confirmation', async () => {
    mocks.read.mockResolvedValue({ loginState: 'signing-out' })
    const { service, child, ready } = fixture()
    let settled = false
    const logout = service.logout('cn').then((status) => {
      settled = true
      return status
    })
    await ready
    await vi.advanceTimersByTimeAsync(750)
    child.close()
    await vi.advanceTimersByTimeAsync(249)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await logout).toMatchObject({ loginState: 'signing-out' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposal interrupts confirmation and drains its timer without stopping an exited child', async () => {
    mocks.read.mockResolvedValue({ loginState: 'signing-out' })
    const { service, child, ready, stop } = fixture()
    const logout = service.logout('cn')
    await ready
    child.close()
    await vi.advanceTimersByTimeAsync(0)
    await service.dispose()
    expect(await logout).toMatchObject({ loginState: 'signing-out' })
    expect(stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    const reads = mocks.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.read).toHaveBeenCalledTimes(reads)
    await expect(service.login('cn')).rejects.toThrow('已关闭')
  })

  it('keeps a configured wrapper and reports unchanged CN metadata despite its zero exit', async () => {
    const { service, child, ready, spawn, configuration } = fixture({
      command: 'C:/fixture/custom-bridge.cmd',
      prefix: ['--profile', 'retained'],
    })
    const logout = service.logout('cn')
    await ready
    child.close()
    await vi.advanceTimersByTimeAsync(1000)

    expect(await logout).toMatchObject({ region: 'cn', loginState: 'signed-in' })
    const launch = commandLaunch(configuration.command, [
      ...configuration.prefix,
      'logout',
      '--region',
      'cn',
    ])
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      launch.command,
      launch.args,
      expect.objectContaining({ stdio: 'ignore' }),
    )
    expect(mocks.path).toHaveBeenCalledWith(configuration)
    expect(mocks.read.mock.calls.every(([region]) => region === 'cn')).toBe(true)
    expect(await service.status('global')).toMatchObject({ loginState: 'signed-in' })
    expect(configuration).toEqual({
      command: 'C:/fixture/custom-bridge.cmd',
      prefix: ['--profile', 'retained'],
    })
  })

  it('rejects a nonzero exit separately from an unchanged state after a zero exit', async () => {
    const { service, child, ready } = fixture()
    const logout = service.logout('cn')
    const rejected = expect(logout).rejects.toThrow('退出未完成')
    await ready
    child.close(1)
    await rejected
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('surfaces a failed timeout stop and retains ownership of the live child', async () => {
    const { service, child, ready, stop, forceStop } = fixture({ failStop: true })
    const logout = service.logout('cn')
    const rejected = expect(logout).rejects.toThrow('无法停止')
    await ready
    await vi.advanceTimersByTimeAsync(1020)
    await rejected
    expect(stop).toHaveBeenCalledOnce()
    expect(forceStop).toHaveBeenCalledOnce()
    await expect(service.login('global')).rejects.toThrow('退出')
    await expect(service.logout('cn')).rejects.toThrow('退出')
    child.close()
    await service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
