/**
 * A keyless, controlled OpenAI-compatible provider on loopback, for behaviour tests.
 *
 * This is **not** evidence that any real model is reachable. It exists so the official Pi
 * CLI can be driven end to end — a real turn, a real tool call, a real cancel — without a
 * real credential and without contacting an OFM channel. Its replies are fixed: one tool
 * call, then a final message, or a configurable stall for the cancel cases.
 *
 * **It streams, because the official product streams.** A raw request captured from Pi
 * 1.2.0 carries `"stream": true`, and answering with a single plain JSON body makes the CLI
 * fail the turn with `Stream ended without finish_reason` — so a non-streaming stand-in
 * would silently prove nothing about the agent loop. The SSE shape below matches the
 * OpenAI chat-completions wire format the official `openai-completions` api expects.
 */
import { createServer, type Server } from 'node:http'

export type ProviderScript =
  /** Emit one `bash` tool call, then finish with text. */
  | 'tool-then-answer'
  /** Never answer, so a turn stays open until it is aborted. */
  | 'stall'
  /** Answer immediately with text and no tool call. */
  | 'answer-only'
  /** Refuse every attempt with an explicit upstream quota failure. */
  | 'rate-limit'

export interface ControlledProvider {
  /** Base URL to hand to the official `models.json`. */
  baseURL: string
  /** Every request path the CLI actually called. */
  readonly requests: string[]
  /** Parsed model request bodies received from the official CLI. */
  readonly payloads: Readonly<Record<string, unknown>>[]
  /** System messages actually received by the controlled provider. */
  readonly systemMessages: string[]
  /** Authorization header values seen, so a test can assert the key was forwarded. */
  readonly authorizations: string[]
  /**
   * Resolve once at least `count` requests have arrived.
   *
   * This is how a test knows the CLI is actually mid-turn before it cancels: it waits on
   * observed provider traffic, never on a timer, so there is no sleep-and-hope race.
   */
  waitForRequest(count?: number): Promise<void>
  close(): Promise<void>
}

/** One SSE frame. */
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

/** The envelope every chunk shares. */
const envelope = (model: string) => ({
  id: 'controlled',
  object: 'chat.completion.chunk',
  created: 0,
  model,
})

/**
 * Start the controlled provider.
 *
 * @param script - which fixed behaviour the endpoint implements.
 */
export async function startControlledProvider(
  script: ProviderScript = 'tool-then-answer',
): Promise<ControlledProvider> {
  const requests: string[] = []
  const payloads: Record<string, unknown>[] = []
  const systemMessages: string[] = []
  const authorizations: string[] = []
  const arrivalWaiters: { count: number; resolve: () => void }[] = []
  let served = 0

  /** Let everyone waiting on a request count that has now been reached. */
  const releaseArrivals = () => {
    for (const waiter of arrivalWaiters.splice(0))
      if (requests.length >= waiter.count) waiter.resolve()
  }

  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    releaseArrivals()
    const auth = req.headers.authorization
    if (auth) authorizations.push(String(auth))
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (script === 'rate-limit') {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }),
        )
        return
      }
      // Hold the socket open: the turn stays in flight until the client aborts it.
      if (script === 'stall') return
      let parsed: any = {}
      try {
        parsed = body ? JSON.parse(body) : {}
      } catch {
        parsed = {}
      }
      payloads.push(parsed)
      for (const message of parsed.messages ?? [])
        if (message.role === 'system' || message.role === 'developer')
          systemMessages.push(JSON.stringify(message.content))
      const turn = served++
      const model = String(parsed.model ?? 'controlled')
      const alreadyRanTool = (parsed.messages ?? []).some((m: any) => m.role === 'tool')
      const wantsTool = script === 'tool-then-answer' && !alreadyRanTool

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })

      // Opening role frame, as the OpenAI format does.
      res.write(
        frame({ ...envelope(model), choices: [{ index: 0, delta: { role: 'assistant' } }] }),
      )

      if (wantsTool) {
        // A real external `git` command, so PATH and quoting under the pinned shell are
        // exercised rather than asserted.
        res.write(
          frame({
            ...envelope(model),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'bash',
                        arguments: JSON.stringify({ command: 'git --version' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        )
        res.write(
          frame({
            ...envelope(model),
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          }),
        )
      } else {
        res.write(
          frame({ ...envelope(model), choices: [{ index: 0, delta: { content: '受控回复' } }] }),
        )
        res.write(
          frame({ ...envelope(model), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        )
      }

      res.write(
        frame({
          ...envelope(model),
          choices: [{ index: 0, delta: {} }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw Error('受控提供方未取得监听端口')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    payloads,
    systemMessages,
    authorizations,
    waitForRequest(count = 1) {
      if (requests.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => arrivalWaiters.push({ count, resolve }))
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
