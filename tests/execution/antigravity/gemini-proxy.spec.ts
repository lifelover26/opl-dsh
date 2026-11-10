import { createServer, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import {
  normalizeGeminiSse,
  startAntigravityGeminiProxy,
  type GeminiProxyFailure,
} from '../../../src/execution/host/adapters/antigravity/gemini-proxy.ts'

const model = 'gemini-3.8-flash'
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const complete = {
  candidates: [{ content: { parts: [{ text: '中文' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
}
async function transform(input: Buffer[]): Promise<string> {
  let result = ''
  await pipeline(Readable.from(input), normalizeGeminiSse(), async (source) => {
    for await (const chunk of source) result += chunk.toString()
  })
  return result
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Fixture listener unavailable')
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
const requestPath = (selected = model) => `/v1beta/models/${selected}:streamGenerateContent?alt=sse`

describe('Antigravity native Gemini SSE compatibility', () => {
  it('removes empty events and comments across split CRLF and UTF-8 without changing model payloads', async () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'run_command', args: { CommandLine: 'printf 中文' } },
                thoughtSignature: 'exact-sig',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 3,
        totalTokenCount: 15,
      },
    }
    const json = JSON.stringify(payload, null, 2)
    const input =
      '\uFEFF\r\n\r\n: heartbeat\r\n\r\n' +
      json
        .split('\n')
        .map((line) => 'data: ' + line)
        .join('\r\n') +
      '\r\n\r\n'
    const output = await transform([...Buffer.from(input)].map((byte) => Buffer.from([byte])))
    expect(output).toBe(frame(payload))
  })

  it('forwards an early candidate before response completion and then accepts its terminal event', async () => {
    const stream = normalizeGeminiSse()
    let output = ''
    stream.on('data', (chunk) => {
      output += chunk.toString()
    })
    const early = { candidates: [{ content: { parts: [{ text: 'first' }] } }] }
    stream.write(frame(early))
    expect(output).toBe(frame(early))
    const done = new Promise<void>((resolve, reject) => {
      stream.on('end', resolve)
      stream.on('error', reject)
    })
    stream.end(frame(complete))
    await done
    expect(output).toBe(frame(early) + frame(complete))
  })

  it.each([
    frame({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }),
    'data: {"candidates":[\n\n',
    frame(complete).slice(0, -1),
    frame({ error: { code: 429, message: 'private-provider-detail' } }),
    'event: error\ndata: {"message":"private-provider-detail"}\n\n',
    frame({ promptFeedback: { blockReason: 'SAFETY' } }),
  ])('rejects incomplete or failed responses without leaking payload text', async (input) => {
    await expect(transform([Buffer.from(input)])).rejects.toThrow(
      'Native Gemini response stream did not complete',
    )
  })
})

describe('Antigravity selected-model Gemini relay', () => {
  it('pins model, origin, route and private key while retaining request bytes and final usage', async () => {
    const requests: {
      path: string | undefined
      body: string
      key: string | string[] | undefined
    }[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      requests.push({ path: req.url, body, key: req.headers['x-goog-api-key'] })
      res
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .end('\r\n: heartbeat\r\n\r\n' + frame(complete))
    })
    const origin = await listen(server)
    const failures: GeminiProxyFailure[] = []
    const usage: unknown[] = []
    const relay = await startAntigravityGeminiProxy({
      route: { baseURL: origin, model, apiKey: 'source-owned-secret', protocol: 'gemini-native' },
      env: {},
      onFailure: (_, value) => failures.push(value),
      onUsageMetadata: (_, value) => usage.push(value),
    })
    const send = (path: string, body: string, key = relay.key) =>
      fetch(relay.baseURL + path, { method: 'POST', headers: { 'x-goog-api-key': key }, body })
    try {
      expect((await send(requestPath(), '{}')).status).toBe(403)
      const scope = relay.beginPrompt()
      expect((await send(requestPath(), '{}', 'wrong')).status).toBe(403)
      expect((await send(requestPath('gemini-3.1-flash-lite-preview'), '{}')).status).toBe(403)
      expect((await send(requestPath() + '&extra=1', '{}')).status).toBe(403)
      expect(failures).toEqual([])
      const body =
        '{ "contents": [{"role":"user","parts":[{"text":"中文"},{"inlineData":{"mimeType":"image/png","data":"eA=="}}]}] }'
      const response = await send(requestPath(), body)
      expect(await response.text()).toBe(frame(complete))
      expect(requests).toEqual([{ path: requestPath(), body, key: 'source-owned-secret' }])
      expect(relay.key).not.toBe('source-owned-secret')
      expect(usage).toEqual([complete.usageMetadata])
      expect(failures).toEqual([])
      relay.finishPrompt(scope)
    } finally {
      await relay.close()
      await close(server)
    }
  })

  it.each([401, 403, 404, 429, 500, 503])(
    'reports HTTP %i from headers before a stalled error body',
    async (status) => {
      let report!: (failure: GeminiProxyFailure) => void
      const reported = new Promise<GeminiProxyFailure>((resolve) => {
        report = resolve
      })
      const server = createServer((req, res) => {
        req.resume()
        res.writeHead(status, { 'content-type': 'application/json' })
        res.flushHeaders()
        res.write('{"error":"never finished private detail')
      })
      const origin = await listen(server)
      const relay = await startAntigravityGeminiProxy({
        route: { baseURL: origin, model, apiKey: 'owned', protocol: 'gemini-native' },
        env: {},
        onFailure: (_, failure) => report(failure),
      })
      try {
        relay.beginPrompt()
        const response = fetch(relay.baseURL + requestPath(), {
          method: 'POST',
          headers: { authorization: `Bearer ${relay.key}` },
          body: '{}',
        })
        expect(await reported).toEqual({ kind: 'http', httpStatus: status })
        expect(await (await response).text()).not.toContain('private detail')
      } finally {
        await relay.close()
        await close(server)
      }
    },
  )

  it('does not forward when the official hook did not prove this invocation ready', async () => {
    let requests = 0
    const failures: GeminiProxyFailure[] = []
    const server = createServer((req, res) => {
      requests++
      req.resume()
      res.end()
    })
    const origin = await listen(server)
    const relay = await startAntigravityGeminiProxy({
      route: { baseURL: origin, model, apiKey: 'owned', protocol: 'gemini-native' },
      env: {},
      beforeForward: async () => {
        throw Error('private hook diagnostic')
      },
      onFailure: (_, failure) => failures.push(failure),
    })
    try {
      relay.beginPrompt()
      const response = await fetch(relay.baseURL + requestPath(), {
        method: 'POST',
        headers: { 'x-goog-api-key': relay.key },
        body: '{}',
      })
      expect(response.status).toBe(503)
      expect(requests).toBe(0)
      expect(failures).toEqual([{ kind: 'policy' }])
    } finally {
      await relay.close()
      await close(server)
    }
  })

  it('aborts old prompt sockets and does not charge their late close to a later prompt', async () => {
    let entered!: () => void
    let left!: () => void
    const pending = new Promise<void>((resolve) => {
      entered = resolve
    })
    const disconnected = new Promise<void>((resolve) => {
      left = resolve
    })
    let requests = 0
    const server = createServer((req, res) => {
      req.resume()
      if (++requests === 1) {
        res.once('close', left)
        entered()
      } else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(complete))
    })
    const origin = await listen(server)
    const failures: unknown[] = []
    const relay = await startAntigravityGeminiProxy({
      route: { baseURL: origin, model, apiKey: 'owned', protocol: 'gemini-native' },
      env: {},
      onFailure: (...args) => failures.push(args),
    })
    const send = () =>
      fetch(relay.baseURL + requestPath(), {
        method: 'POST',
        headers: { 'x-goog-api-key': relay.key },
        body: '{}',
      })
    try {
      const first = relay.beginPrompt()
      const stalled = send().catch(() => undefined)
      await pending
      relay.finishPrompt(first)
      const second = relay.beginPrompt()
      expect(await (await send()).text()).toBe(frame(complete))
      await Promise.all([stalled, disconnected])
      expect(failures).toEqual([])
      relay.finishPrompt(second)
    } finally {
      await relay.close()
      await close(server)
    }
  })

  it('uses the selected HTTP proxy environment for upstream requests', async () => {
    let originRequests = 0
    const target = createServer((req, res) => {
      originRequests++
      req.resume()
      res.end()
    })
    const origin = await listen(target)
    const forwarded: string[] = []
    const proxy = createServer((req, res) => {
      forwarded.push(req.url ?? '')
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(complete))
    })
    const proxyOrigin = await listen(proxy)
    const relay = await startAntigravityGeminiProxy({
      route: { baseURL: origin, model, apiKey: 'owned', protocol: 'gemini-native' },
      env: { HTTP_PROXY: proxyOrigin, NO_PROXY: '' },
    })
    try {
      relay.beginPrompt()
      const response = await fetch(relay.baseURL + requestPath(), {
        method: 'POST',
        headers: { 'x-goog-api-key': relay.key },
        body: '{}',
      })
      expect(await response.text()).toBe(frame(complete))
      expect(forwarded).toEqual([origin + requestPath()])
      expect(originRequests).toBe(0)
    } finally {
      await relay.close()
      await close(proxy)
      await close(target)
    }
  })
})
