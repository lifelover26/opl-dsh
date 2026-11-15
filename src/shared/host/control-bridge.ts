/** Authenticated loopback control of the existing Desktop Host Remote services. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'

const allowed: Readonly<Record<string, readonly string[]>> = {
  session: [
    'list',
    'create',
    'prompt',
    'cancel',
    'rename',
    'selectModel',
    'modelCatalog',
    'permissions',
    'selectPermissions',
    'updateQueue',
    'page',
    'snapshot',
    'controlSnapshot',
    'wait',
  ],
  // Official DSH derives Session membership from the workspace supplied to
  // session.create; it does not export a workspace.moveSession Remote method.
  workspace: ['follow'],
  oplSuite: ['setupUrl', 'setupStatus', 'finishSetup'],
  oplGatewayAccount: ['status', 'refresh'],
  taskFeedback: [
    'register',
    'task',
    'tasks',
    'outbox',
    'wake',
    'ack',
    'receive',
    'receipts',
    'consume',
    'resumeFailed',
    'flush',
  ],
  harness: [
    'official-tools',
    'official-call',
    'delegate',
    'tasks',
    'report',
    'review',
    'result',
    'retry-delivery',
    'start',
    'prompt',
    'cancel',
    'snapshot',
    'list',
    'wait',
    'catalog',
    'save-catalog',
    'save-harness-proxy',
    'select-minimax-candidate',
    'select-codex-runtime',
  ],
  oplExecution: [
    'catalog',
    'combinations',
    'harness-installations',
    'save-catalog',
    'message-edit-state',
    'message-edit-send',
  ],
}

/**
 * Map one allowlisted stream request to the Remote method the gateway opens.
 * @param namespace - requested Remote namespace.
 * @param method - requested control method.
 * @returns the streamed Remote method, or `undefined` for a unary call.
 */
function streamedMethod(namespace: string, method: string): string | undefined {
  if (namespace === 'session' && method === 'snapshot') return 'follow'
  if (namespace === 'session' && method === 'controlSnapshot') return 'control'
  if (namespace === 'workspace' && method === 'follow') return 'follow'
  return undefined
}

/** Default deadline for one control call, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 150_000

/** Longest deadline any single control call may request. */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** Largest request body the bridge accepts, in bytes. */
const MAX_REQUEST_BYTES = 256_000

/**
 * Read the optional per-call deadline from one RPC envelope.
 *
 * A wait call blocks until the Session actually settles, which can outlast any
 * fixed bridge default, so the caller names its own bound. An absent value uses
 * {@link DEFAULT_TIMEOUT_MS}; anything outside `1 .. MAX_TIMEOUT_MS` is rejected
 * rather than clamped, because a deadline the caller did not ask for turns a
 * deliberate long wait into a surprise timeout.
 * @param value - raw `timeoutMs` field from the request envelope.
 * @returns the deadline to apply, in milliseconds.
 * @throws when the field is present but not a usable duration.
 */
function resolveTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new Error(`timeoutMs must be an integer from 1 through ${String(MAX_TIMEOUT_MS)}`)
  }
  return value
}

/**
 * Compare a supplied bearer header against the launch token without leaking timing.
 * @param supplied - raw `authorization` header, or the empty string.
 * @param token - token this bridge issued.
 * @returns whether the header carries exactly this token.
 */
function authorized(supplied: string, token: string): boolean {
  const left = Buffer.from(supplied)
  const right = Buffer.from(`Bearer ${token}`)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Read the stable code and structured details off a business failure.
 *
 * The gateway preserves a `RemoteError`'s identity, and that class publishes a
 * structural marker so a caller can report the code without importing the
 * business-error class. A failure without the marker stays a plain message.
 * @param error - the caught failure.
 * @returns the remote code and details, or undefined for a carrier failure.
 */
function remoteFailure(error: unknown): { code: string; details: unknown } | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as { isDSHRemoteError?: unknown; code?: unknown; details?: unknown }
  if (candidate.isDSHRemoteError !== true || typeof candidate.code !== 'string') return undefined
  return { code: candidate.code, details: candidate.details }
}

/** Start a local-only authenticated bridge; all commands use the same GUI services. */
export async function startControlBridge(
  gateway: Pick<TypertGateway, 'invoke' | 'stream'>,
  peer: PeerScope,
  filename: string,
): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString('hex')
  const pending = new Set<AbortController>()
  const completions = new Set<Promise<void>>()

  const reply = (res: ServerResponse, status: number, value: unknown): void => {
    if (res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.origin !== undefined || !authorized(req.headers.authorization ?? '', token)) {
      reply(res, 403, { error: 'unauthorized' })
      return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      reply(res, 404, { error: 'not found' })
      return
    }
    const controller = new AbortController()
    const completion = Promise.withResolvers<void>()
    completions.add(completion.promise)
    pending.add(controller)
    const closed = (): void => {
      if (!res.writableFinished) controller.abort()
    }
    res.on('close', closed)
    // Held in an object rather than a local so the deadline callback's write is
    // visible to the catch below through a property read.
    const deadline = { reached: false }
    try {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array)
        size += bytes.byteLength
        if (size > MAX_REQUEST_BYTES) {
          reply(res, 413, { error: 'request too large' })
          return
        }
        chunks.push(bytes)
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('Expected an RPC object')
      const data = parsed as Record<string, unknown>
      if (
        typeof data.namespace !== 'string' ||
        typeof data.method !== 'string' ||
        !allowed[data.namespace]?.includes(data.method)
      ) {
        reply(res, 403, { error: 'method not allowed' })
        return
      }
      if (typeof data.args !== 'object' || data.args === null || Array.isArray(data.args)) {
        throw new Error('Expected named arguments')
      }
      const expiry = AbortSignal.timeout(resolveTimeout(data.timeoutMs))
      expiry.addEventListener(
        'abort',
        () => {
          deadline.reached = true
        },
        { once: true },
      )
      const invocation = {
        namespace: data.namespace,
        method: data.method,
        args: data.args as Record<string, unknown>,
        signal: AbortSignal.any([controller.signal, expiry]),
      }
      let value: unknown
      const streamed = streamedMethod(data.namespace, data.method)
      if (streamed !== undefined) {
        const stream = await gateway.stream({ ...invocation, method: streamed, peer })
        const iterator = stream[Symbol.asyncIterator]()
        try {
          value = (await iterator.next()).value
        } finally {
          controller.abort()
          await iterator.return?.()
        }
      } else value = await gateway.invoke({ ...invocation, peer })
      reply(res, 200, { ok: true, value })
    } catch (error) {
      // A deadline the bridge itself imposed is reported as a timeout, not as
      // the cancellation the aborted call observes: the caller must be able to
      // tell "this Session is still working" from "I gave up".
      if (deadline.reached)
        reply(res, 504, { ok: false, error: 'control call timed out', code: 'timeout' })
      else {
        const failure = remoteFailure(error)
        reply(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : 'Control request failed',
          ...(failure === undefined ? {} : failure),
        })
      }
    } finally {
      pending.delete(controller)
      completion.resolve()
      completions.delete(completion.promise)
      res.off('close', closed)
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })
  // The response deadline belongs to the call, not the socket: `wait` blocks
  // until its Session settles and names its own bound in the envelope, so the
  // server must not close a request that is still doing its job.
  server.requestTimeout = 0
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Control bridge did not bind')
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  try {
    const temp = `${filename}.${String(process.pid)}.tmp`
    const endpoint = `http://127.0.0.1:${String(address.port)}/rpc`
    writeFileSync(temp, JSON.stringify({ version: 1, pid: process.pid, endpoint, token }), {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temp, filename)
  } catch (error) {
    server.close()
    throw error
  }
  return async () => {
    for (const controller of pending) controller.abort()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
      server.closeAllConnections()
    })
    await Promise.allSettled([...completions])
    try {
      const stored = JSON.parse(readFileSync(filename, 'utf8')) as { token?: unknown }
      if (stored.token === token) unlinkSync(filename)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
