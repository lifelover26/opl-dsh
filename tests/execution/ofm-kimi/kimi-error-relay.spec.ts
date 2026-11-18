import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import {
  startKimiErrorRelay,
  kimiProviderFailure,
  type KimiErrorRelay,
} from '../../../src/execution/host/adapters/kimi/kimi-error-relay.ts'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function setup(reply: (res: ServerResponse) => void) {
  let count = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      count++
      reply(res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanup.push(
    () =>
      new Promise((r) => {
        server.close(() => r())
        server.closeAllConnections()
      }),
  )
  const address = server.address() as { port: number }
  const relay = await startKimiErrorRelay({
    baseURL: `http://127.0.0.1:${address.port}`,
    apiKey: 'private-provider-key',
    model: 'model',
  })
  cleanup.push(() => relay.close())
  const call = (key = relay.key) =>
    fetch(relay.baseURL + '/v1/messages?beta=true', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'model', messages: [] }),
    })
  return { relay, call, count: () => count }
}
describe('Kimi request error observation', () => {
  it.each([
    [429, 'quota', 'HARNESS_PROVIDER_RATE_LIMIT'],
    [502, 'The model has reached its end of life', 'HARNESS_PROVIDER_RETIRED'],
    [502, 'Function secret: Not found for account secret', 'HARNESS_PROVIDER_ROUTE'],
    [502, 'secret diagnostic', 'HARNESS_PROVIDER'],
  ])('classifies HTTP %s without retaining provider text', async (status, message, code) => {
    const { relay, call, count } = await setup((res) => {
      res.writeHead(status as number, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { message } }))
    })
    relay.begin()
    const response = await call()
    expect(response.status).toBe(status)
    await response.text()
    expect(relay.end()).toBe(code)
    expect(count()).toBe(1)
    relay.begin()
    expect(relay.end()).toBeUndefined()
  })
  it('preserves provider retry hints and accepts a successful CLI retry', async () => {
    let attempts = 0
    const { relay, call, count } = await setup((res) => {
      if (++attempts === 1) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '2',
          'retry-after-ms': '1500',
          'x-should-retry': 'true',
        })
        res.end('{"error":{"message":"temporary quota"}}')
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"type":"message_stop"}\n\n')
      }
    })
    relay.begin()
    const first = await call()
    expect(first.status).toBe(429)
    expect(first.headers.get('retry-after')).toBe('2')
    expect(first.headers.get('retry-after-ms')).toBe('1500')
    expect(first.headers.get('x-should-retry')).toBe('true')
    await first.text()
    const recovered = await call()
    expect(recovered.status).toBe(200)
    await recovered.text()
    expect(count()).toBe(2)
    expect(relay.end()).toBeUndefined()
  })
  it('retains a failure after streamed answer text', async () => {
    const { relay, call } = await setup((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"delta":{"text":"partial"}}\n\n')
      res.end(
        'event: error\ndata: {"type":"error","error":{"code":"NO_PROGRESS","message":"secret"}}\n\n',
      )
    })
    relay.begin()
    expect(await (await call()).text()).toContain('partial')
    expect(relay.end()).toBe('HARNESS_PROVIDER_TIMEOUT')
  })
  it('does not turn normal empty or nonempty success into a provider error', async () => {
    const { relay, call } = await setup((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"type":"message_stop"}\n\n')
    })
    relay.begin()
    await (await call()).text()
    expect(relay.end()).toBeUndefined()
  })
  it('refuses idle and unauthenticated requests before forwarding', async () => {
    const { relay, call, count } = await setup((res) => res.end('{}'))
    expect((await call()).status).toBe(403)
    relay.begin()
    expect((await call('wrong')).status).toBe(403)
    expect(count()).toBe(0)
  })
  it('cancellation and late responses cannot contaminate the next prompt', async () => {
    let reply: ServerResponse | undefined
    const { relay, call } = await setup((res) => {
      reply = res
    })
    relay.begin()
    const pending = call()
      .then((r) => r.text())
      .catch(() => undefined)
    while (!reply) await new Promise((r) => setImmediate(r))
    relay.cancel()
    expect(relay.end()).toBeUndefined()
    relay.begin()
    reply.writeHead(502)
    reply.end('{"error":{"message":"retired model"}}')
    await pending
    expect(relay.end()).toBeUndefined()
  })
  it('keeps independent CLI sessions separate', async () => {
    const a = await setup((res) => {
      res.writeHead(429)
      res.end('{}')
    })
    const b = await setup((res) => res.end('{}'))
    a.relay.begin()
    b.relay.begin()
    await (await a.call()).text()
    await (await b.call()).text()
    expect(a.relay.end()).toBe('HARNESS_PROVIDER_RATE_LIMIT')
    expect(b.relay.end()).toBeUndefined()
  })
  it('never echoes arbitrary error messages', () => {
    expect(kimiProviderFailure(500, { error: { message: 'token account https://private' } })).toBe(
      'HARNESS_PROVIDER',
    )
  })
})
