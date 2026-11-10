/** A single-model native Gemini relay for Antigravity's SSE parser. */
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { randomBytes } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'

/** The model-source owner's resolved native route. The key never enters CLI settings. */
export interface AntigravityNativeRoute {
  readonly baseURL: string
  readonly model: string
  readonly apiKey: string
  readonly protocol: 'gemini-native'
  readonly contextWindow?: number
}

/** Credential-free facts about one selected-model request. */
export interface GeminiProxyFailure {
  readonly kind: 'http' | 'network' | 'stream' | 'policy'
  readonly httpStatus?: number
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** One Gemini SSE stream failed before its advertised completion. */
class GeminiStreamError extends Error {
  constructor(readonly failure: GeminiProxyFailure = { kind: 'stream' }) {
    super('Native Gemini response stream did not complete')
  }
}

/**
 * Parse SSE line endings and emit one compact JSON data event at a time.
 * @param onPayload - Observes decoded payloads without modifying candidate or usage fields.
 * @returns A streaming transform that rejects malformed or incomplete native responses.
 */
export function normalizeGeminiSse(onPayload?: (value: unknown) => void): Transform {
  const decoder = new StringDecoder('utf8')
  let line = ''
  let skipLf = false
  let first = true
  let eventName = ''
  let eventSize = 0
  let data: string[] = []
  const candidates = new Set<number>()
  const finished = new Set<number>()
  const frameLimit = 16 * 1024 * 1024
  let stream!: Transform

  function dispatch(): void {
    if (!data.length) {
      eventName = ''
      eventSize = 0
      return
    }
    const raw = data.join('\n')
    data = []
    eventSize = 0
    if (raw === '[DONE]') {
      if (!candidates.size || [...candidates].some((index) => !finished.has(index)))
        throw new GeminiStreamError()
      eventName = ''
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new GeminiStreamError()
    }
    const value = object(payload)
    if (!Object.keys(value).length) throw new GeminiStreamError()
    if (eventName === 'error' || Object.hasOwn(value, 'error')) {
      const code = object(value.error).code
      throw new GeminiStreamError({
        kind: 'stream',
        ...(typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599
          ? { httpStatus: code }
          : {}),
      })
    }
    if (typeof object(value.promptFeedback).blockReason === 'string') throw new GeminiStreamError()
    if (Array.isArray(value.candidates)) {
      for (const entry of value.candidates) {
        const candidate = object(entry)
        const index = candidate.index === undefined ? 0 : candidate.index
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)
          throw new GeminiStreamError()
        candidates.add(index)
        if (typeof candidate.finishReason === 'string' && candidate.finishReason.length)
          finished.add(index)
      }
    }
    onPayload?.(payload)
    stream.push('data: ' + JSON.stringify(payload) + '\n\n')
    eventName = ''
  }

  function acceptLine(value: string): void {
    if (value === '') {
      dispatch()
      return
    }
    if (value.startsWith(':')) return
    const split = value.indexOf(':')
    const field = split < 0 ? value : value.slice(0, split)
    let content = split < 0 ? '' : value.slice(split + 1)
    if (content.startsWith(' ')) content = content.slice(1)
    if (field === 'event') eventName = content
    if (field === 'data') {
      eventSize += content.length
      if (eventSize > frameLimit) throw new GeminiStreamError()
      data.push(content)
    }
  }

  function accept(text: string): void {
    for (const char of text) {
      if (first) {
        first = false
        if (char === '\uFEFF') continue
      }
      if (skipLf) {
        skipLf = false
        if (char === '\n') continue
      }
      if (char === '\r' || char === '\n') {
        acceptLine(line)
        line = ''
        skipLf = char === '\r'
      } else {
        line += char
        if (line.length > frameLimit) throw new GeminiStreamError()
      }
    }
  }

  stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        accept(decoder.write(chunk))
        done()
      } catch (error) {
        done(error as Error)
      }
    },
    flush(done) {
      try {
        accept(decoder.end())
        // SSE dispatch requires a blank line. A partial data event at EOF is not a result.
        if (line && !line.startsWith(':')) throw new GeminiStreamError()
        if (
          data.length ||
          !candidates.size ||
          [...candidates].some((index) => !finished.has(index))
        )
          throw new GeminiStreamError()
        done()
      } catch (error) {
        done(error as Error)
      }
    },
  })
  return stream
}

interface ForwardedRequest {
  readonly scope: number
  readonly response: ServerResponse
  request?: ClientRequest
  upstream?: IncomingMessage
}

/** A loopback relay whose errors and sockets belong to a single active ACP prompt. */
export interface AntigravityGeminiProxy {
  readonly baseURL: string
  readonly key: string
  /** Begin before forwarding session/prompt; only one prompt may own native requests. */
  beginPrompt(): number
  /** Stop attributing requests and abort any uncompleted sockets from this prompt. */
  finishPrompt(scope: number): void
  /** Close all sockets and listeners; repeated disposal shares the same completion. */
  close(): Promise<void>
}

/**
 * Forward native Gemini requests using the selected Harness proxy environment.
 * @param options - One exact source route, hook readiness check, and prompt-scoped observers.
 * @returns An authenticated loopback endpoint and an awaited disposal operation.
 */
export async function startAntigravityGeminiProxy(options: {
  route: AntigravityNativeRoute
  env?: NodeJS.ProcessEnv
  beforeForward?: () => Promise<void>
  onFailure?: (scope: number, failure: GeminiProxyFailure) => void
  onUsageMetadata?: (scope: number, value: unknown) => void
}): Promise<AntigravityGeminiProxy> {
  const upstream = new URL(options.route.baseURL)
  if (
    !['https:', 'http:'].includes(upstream.protocol) ||
    (upstream.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    upstream.pathname !== '/' ||
    options.route.protocol !== 'gemini-native' ||
    !options.route.apiKey ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.route.model)
  )
    throw Error('Antigravity requires a resolved native Gemini origin and exact model')
  const env = options.env ?? process.env
  const httpAgent = new HttpAgent({ proxyEnv: env, keepAlive: true })
  const httpsAgent = new HttpsAgent({ proxyEnv: env, keepAlive: true })
  const key = randomBytes(32).toString('hex')
  const nativePath = `/v1beta/models/${options.route.model}:streamGenerateContent`
  const inflight = new Set<ForwardedRequest>()
  const failures = new Set<number>()
  let nextScope = 0
  let active: number | undefined
  let closed = false

  function report(scope: number, failure: GeminiProxyFailure): void {
    if (closed || active !== scope || failures.has(scope)) return
    failures.add(scope)
    options.onFailure?.(scope, failure)
  }

  function abortScope(scope: number): void {
    for (const item of inflight) {
      if (item.scope !== scope) continue
      item.upstream?.destroy()
      item.request?.destroy()
      item.response.destroy()
      inflight.delete(item)
    }
  }

  const server = createServer((req, res) => {
    const scope = active
    let url: URL
    try {
      url = new URL(req.url ?? '', 'http://127.0.0.1')
    } catch {
      req.resume()
      res.writeHead(400).end()
      return
    }
    const queryKey = url.searchParams.get('key')
    const authenticated =
      req.headers['x-goog-api-key'] === key ||
      req.headers.authorization === `Bearer ${key}` ||
      queryKey === key
    const queryValid =
      url.searchParams.get('alt') === 'sse' &&
      [...url.searchParams.keys()].every((name) => ['alt', 'key'].includes(name)) &&
      url.searchParams.getAll('alt').length === 1 &&
      url.searchParams.getAll('key').length <= 1
    if (
      closed ||
      req.method !== 'POST' ||
      url.origin !== 'http://127.0.0.1' ||
      url.pathname !== nativePath ||
      !queryValid ||
      !authenticated ||
      scope === undefined ||
      failures.has(scope)
    ) {
      // CLI auxiliary models are intentionally refused without billing another model or
      // attributing their failure to the selected model's current request.
      req.resume()
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: { code: 403, status: 'PERMISSION_DENIED', message: 'Route not selected' },
        }),
      )
      return
    }
    const chunks: Buffer[] = []
    const bodyLimit = 64 * 1024 * 1024
    let size = 0
    const item: ForwardedRequest = { scope, response: res }
    inflight.add(item)
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= bodyLimit) chunks.push(chunk)
    })
    req.once('error', () => {
      inflight.delete(item)
      res.destroy()
    })
    res.once('close', () => {
      item.request?.destroy()
      inflight.delete(item)
    })
    req.once('end', () => {
      void (async () => {
        if (size > bodyLimit) {
          report(scope, { kind: 'policy' })
          res.writeHead(413).end()
          return
        }
        const body = Buffer.concat(chunks)
        let parsed: unknown
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          report(scope, { kind: 'policy' })
          res.writeHead(400).end()
          return
        }
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          (object(parsed).model !== undefined && object(parsed).model !== options.route.model)
        ) {
          report(scope, { kind: 'policy' })
          res.writeHead(400).end()
          return
        }
        try {
          await options.beforeForward?.()
        } catch {
          report(scope, { kind: 'policy' })
          if (!res.destroyed) res.writeHead(503).end()
          return
        }
        if (closed || active !== scope || failures.has(scope) || res.destroyed) {
          res.destroy()
          return
        }
        const request = upstream.protocol === 'https:' ? httpsRequest : httpRequest
        const forward = request(
          new URL(nativePath + '?alt=sse', upstream),
          {
            method: 'POST',
            agent: upstream.protocol === 'https:' ? httpsAgent : httpAgent,
            headers: {
              'x-goog-api-key': options.route.apiKey,
              'content-type': 'application/json',
              'content-length': body.length,
              'accept-encoding': 'identity',
            },
          },
          (response) => {
            item.upstream = response
            const status = response.statusCode ?? 502
            if (status < 200 || status >= 300) {
              report(scope, { kind: 'http', httpStatus: status })
              response.destroy()
              if (!res.destroyed)
                res.writeHead(status, { 'content-type': 'application/json' }).end(
                  JSON.stringify({
                    error: { code: status, message: 'Native Gemini request failed' },
                  }),
                )
              return
            }
            if (
              !String(response.headers['content-type']).toLowerCase().includes('text/event-stream')
            ) {
              report(scope, { kind: 'stream' })
              response.destroy()
              if (!res.destroyed) res.writeHead(502).end()
              return
            }
            res.writeHead(status, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
            })
            const normalize = normalizeGeminiSse((payload) => {
              if (closed || active !== scope || failures.has(scope)) return
              const usage = object(payload).usageMetadata
              if (usage !== undefined) options.onUsageMetadata?.(scope, usage)
            })
            void pipeline(response, normalize, res).catch((error: unknown) => {
              report(
                scope,
                error instanceof GeminiStreamError ? error.failure : { kind: 'network' },
              )
              res.destroy()
            })
          },
        )
        item.request = forward
        forward.once('error', () => {
          report(scope, { kind: 'network' })
          if (!res.headersSent && !res.destroyed) res.writeHead(502).end()
          else res.destroy()
        })
        forward.end(body)
      })().catch(() => {
        report(scope, { kind: 'network' })
        res.destroy()
      })
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    httpAgent.destroy()
    httpsAgent.destroy()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string')
    throw Error('Antigravity loopback address unavailable')
  let closing: Promise<void> | undefined
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    key,
    beginPrompt() {
      if (closed || active !== undefined) throw Error('Antigravity native prompt is already active')
      active = ++nextScope
      return active
    },
    finishPrompt(scope) {
      if (active === scope) active = undefined
      abortScope(scope)
      failures.delete(scope)
    },
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        closed = true
        active = undefined
        for (const item of inflight) {
          item.upstream?.destroy()
          item.request?.destroy()
          item.response.destroy()
        }
        inflight.clear()
        failures.clear()
        httpAgent.destroy()
        httpsAgent.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      })),
  }
}
