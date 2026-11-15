import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { HarnessService } from '../../src/execution/host/harness.ts'
const mocks = vi.hoisted(() => ({
  provide: vi.fn(),
  wait: vi.fn(async () => ({ turn: 1, outcome: { kind: 'completed' } })),
}))
vi.mock('../../src/execution/host/session-wait.ts', () => ({ waitForSession: mocks.wait }))
import { installExternalCodex } from '../../src/collaboration/host/external-codex.ts'
import { testPeerConnection } from '../test-peer.ts'

it('accepts both official helper and legacy control CLI wait arguments without forwarding to a missing Remote', async () => {
  const gateway = { invoke: vi.fn(), stream: vi.fn() }
  const ctx = {
    connection: testPeerConnection,
    typertGateway: gateway,
    effect: (action: () => unknown) => action(),
    provide: (_name: string, value: unknown) => mocks.provide(value),
  }
  const harness = { cooperationSettings: () => ({ externalCodex: true }) }
  installExternalCodex(ctx as unknown as Context, harness as unknown as HarnessService)
  const bridge = mocks.provide.mock.calls.at(-1)![0] as Pick<TypertGateway, 'invoke'>
  for (const args of [{ sessionId: 's1', turn: 1 }, { request: { sessionId: 's1', turn: 1 } }]) {
    expect(await bridge.invoke({ namespace: 'session', method: 'wait', args })).toEqual({
      turn: 1,
      outcome: { kind: 'completed' },
    })
  }
  expect(mocks.wait).toHaveBeenCalledTimes(2)
  expect(mocks.wait).toHaveBeenLastCalledWith(
    ctx,
    { sessionId: 's1', turn: 1 },
    expect.any(AbortSignal),
  )
  for (const args of [{ request: {} }, { request: { sessionId: 's1', turn: -1 } }]) {
    await expect(bridge.invoke({ namespace: 'session', method: 'wait', args })).rejects.toThrow(
      'session.wait requires',
    )
  }
  expect(gateway.invoke).not.toHaveBeenCalled()
})

it('carries the official Peer through control bridge calls and subscriptions', async () => {
  const peer = { id: 'control-owner' }
  const createPeer = vi.fn(() => peer)
  const gateway = { invoke: vi.fn(), stream: vi.fn() }
  const ctx = {
    typertGateway: gateway,
    get: (name: string) => (name === 'connection' ? { createPeer } : undefined),
    effect: (action: () => unknown) => action(),
    provide: (_name: string, value: unknown) => mocks.provide(value),
  }
  const harness = { cooperationSettings: () => ({ externalCodex: true }) }
  installExternalCodex(ctx as unknown as Context, harness as unknown as HarnessService)
  const bridge = mocks.provide.mock.calls.at(-1)![0] as Pick<TypertGateway, 'invoke' | 'stream'>
  const read = { namespace: 'session', method: 'list', args: {} }
  const follow = { namespace: 'workspace', method: 'follow', args: {} }
  await bridge.invoke(read)
  await bridge.stream(follow)
  expect(gateway.invoke).toHaveBeenCalledWith(
    expect.objectContaining({ ...read, peer, signal: expect.any(AbortSignal) }),
  )
  expect(gateway.stream).toHaveBeenCalledWith(
    expect.objectContaining({ ...follow, peer, signal: expect.any(AbortSignal) }),
  )
  expect(createPeer).toHaveBeenCalledOnce()
})

it('revokes a retained external control port when the collaboration plugin unloads', async () => {
  const disposers: (() => void)[] = []
  const ctx = {
    provide: (_name: string, value: unknown) => mocks.provide(value),
    effect: (action: () => () => void) => {
      disposers.push(action())
    },
  }
  installExternalCodex(
    ctx as unknown as Context,
    { cooperationSettings: () => ({ externalCodex: true }) } as HarnessService,
  )
  const bridge = mocks.provide.mock.calls.at(-1)![0] as Pick<TypertGateway, 'invoke' | 'stream'>
  disposers.forEach((dispose) => dispose())
  await expect(
    bridge.invoke({ namespace: 'session', method: 'wait', args: { sessionId: 's1' } }),
  ).rejects.toThrow()
})
