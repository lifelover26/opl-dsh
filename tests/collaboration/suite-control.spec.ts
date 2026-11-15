import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
const capture = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('../../src/shared/host/control-bridge.ts', () => ({ startControlBridge: capture.start }))
import { apply } from '../../src/shared/host/suite-control.ts'

it('keeps the base launch binding available while optional collaboration operations disappear', async () => {
  let port: Pick<TypertGateway, 'invoke' | 'stream'> | undefined
  const connection = {
    createPeer: () => ({ id: 'base-owner' }),
    authenticatedUrl: (url: string) => url,
  }
  const ctx = {
    connection,
    webServer: { port: 1234 },
    get: (name: string) =>
      name === 'connection' ? connection : name === 'oplExternalControl' ? port : undefined,
    effect: (operation: () => unknown) => operation(),
  } as unknown as Context
  apply(ctx)
  const bridge = capture.start.mock.calls.at(-1)![0] as Pick<TypertGateway, 'invoke' | 'stream'>
  const setup = { namespace: 'oplSuite', method: 'setupUrl', args: {} }
  expect(await bridge.invoke(setup)).toBe('http://127.0.0.1:1234/#opl-setup')
  const request = { namespace: 'session', method: 'list', args: {} }
  await expect(bridge.invoke(request)).rejects.toThrow('未启用')
  const invoke = vi.fn(async () => ({ items: [] }))
  port = { invoke, stream: vi.fn() } as unknown as typeof port
  expect(await bridge.invoke(request)).toEqual({ items: [] })
  expect(invoke).toHaveBeenCalledWith(request)
  port = undefined
  await expect(bridge.invoke(request)).rejects.toThrow('未启用')
  expect(await bridge.invoke(setup)).toBe('http://127.0.0.1:1234/#opl-setup')
  expect(capture.start).toHaveBeenCalledOnce()
})
