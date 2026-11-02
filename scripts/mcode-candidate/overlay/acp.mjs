/** Conversation-only OPL extensions around the pinned official ACP server. */
import { createHash } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

export const historyCapability = {
  version: 1,
  methods: ['opl/session/history/list', 'opl/session/history/rewind'],
  notifications: ['opl/session/history/boundary'],
}

export const usageNotification = 'opl/session/usage'

const concreteId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.includes('\0')
const requestKey = (value) => JSON.stringify(value)
const ownsSession = (frame) =>
  frame.id !== undefined &&
  (frame.method?.startsWith('mcode/session/') ||
    (frame.method?.startsWith('session/') && frame.method !== 'session/cancel'))
const fail = (message = 'MiniMax conversation operation was rejected.') => {
  throw Object.assign(new Error(message), { rpcCode: -32602 })
}

/** Decode JSONL without splitting multibyte text across pipe chunks. */
export function jsonLines(receive) {
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  return new Writable({
    write(chunk, _encoding, done) {
      try {
        buffered += decoder.write(chunk)
        if (buffered.length > 16 * 1024 * 1024) throw Error('ACP frame exceeds 16 MiB.')
        let end
        while ((end = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, end)
          buffered = buffered.slice(end + 1)
          if (line.trim()) receive(line)
        }
        done()
      } catch (error) {
        done(error)
      }
    },
    final(done) {
      try {
        buffered += decoder.end()
        if (buffered.trim()) receive(buffered)
        done()
      } catch (error) {
        done(error)
      }
    },
  })
}

/**
 * Reserve lifecycle operations before the first await; cancellation stays on the
 * official channel while a prompt owns its reservation until its final response.
 */
export function createAcpOverlay({ runtime, shell, output }) {
  const input = new PassThrough()
  const attached = new Set()
  const busy = new Set()
  const pending = new Map()
  const prompts = new Map()
  let closed = false
  let supportsNotifications = false
  const write = (frame) => {
    if (!closed) output.write(JSON.stringify(frame) + '\n')
  }
  const reject = (id, error) =>
    write({
      jsonrpc: '2.0',
      id,
      error: {
        code: error.rpcCode ?? -32603,
        message: error.rpcCode ? error.message : 'MiniMax conversation operation failed.',
      },
    })

  async function history(frame) {
    const p = frame.params ?? {}
    if (!concreteId(p.sessionId) || !attached.has(p.sessionId)) fail('Session is not attached.')
    if (busy.has(p.sessionId)) fail('Session is busy; wait for the current operation to finish.')
    busy.add(p.sessionId)
    try {
      await shell.verify(p.sessionId)
      if (closed) fail('ACP connection is closed.')
      if (frame.method === historyCapability.methods[0]) {
        const summaries = await runtime.listSessionInputSummaries(p.sessionId)
        if (closed) fail('ACP connection is closed.')
        const entries = summaries.map((item) => ({
          userMessageId: item.userMessageId,
          ...(typeof item.contentHead === 'string' ? { contentHead: item.contentHead } : {}),
          timestamp: item.timestamp,
          fileChangeCount: item.fileChangeCount ?? 0,
          ...(item.assistantMessageId ? { assistantMessageId: item.assistantMessageId } : {}),
        }))
        if (entries.some((e) => !concreteId(e.userMessageId) || !Number.isFinite(e.timestamp)))
          throw Error('Invalid native history.')
        return { version: 1, sessionId: p.sessionId, entries }
      }
      if (!concreteId(p.userMessageId) || !concreteId(p.clientRequestId))
        fail('A message and operation id are required.')
      if (
        Object.keys(p).some(
          (key) =>
            !['sessionId', 'userMessageId', 'clientRequestId', 'rewindTurnDiff'].includes(key),
        ) ||
        (p.rewindTurnDiff !== undefined && p.rewindTurnDiff !== false)
      )
        fail('Only conversation history can be rewound; file restoration is unavailable.')
      const operation =
        'oplsh1-' +
        createHash('sha256')
          .update(p.sessionId + '\0' + p.clientRequestId)
          .digest('hex')
          .slice(0, 32)
      const result = await runtime.rewindSession({
        sessionId: p.sessionId,
        userMessageId: p.userMessageId,
        clientRequestId: operation,
        rewindTurnDiff: false,
      })
      if (result.rewound !== true || !Array.isArray(result.deletedMessageIds))
        throw Error('Rewind was not confirmed.')
      return {
        version: 1,
        rewound: true,
        sessionId: p.sessionId,
        userMessageId: p.userMessageId,
        clientRequestId: p.clientRequestId,
        deletedMessageIds: result.deletedMessageIds,
        ...(result.historyRevision ? { historyRevision: result.historyRevision } : {}),
        ...(result.displayRevision ? { displayRevision: result.displayRevision } : {}),
      }
    } finally {
      busy.delete(p.sessionId)
    }
  }

  function accept(line) {
    if (closed || input.writableEnded) return
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      input.write(line + '\n')
      return
    }
    if (historyCapability.methods.includes(frame.method) && frame.id !== undefined) {
      // history() reserves synchronously before yielding to native storage.
      void history(frame).then(
        (result) => write({ jsonrpc: '2.0', id: frame.id, result }),
        (error) => reject(frame.id, error),
      )
      return
    }
    if (frame.method === 'initialize') {
      const c = frame.params?.clientCapabilities?._meta
      supportsNotifications = Boolean(
        c?.['minimax-code/extensions']?.notifications || c?.['minimax-code/extensions'] === true,
      )
    }
    const id = frame.params?.sessionId
    const lifecycle = ownsSession(frame)
    if (lifecycle && concreteId(id)) {
      if (busy.has(id)) {
        reject(frame.id, {
          rpcCode: -32602,
          message: 'Session is busy; wait for the current operation to finish.',
        })
        return
      }
      busy.add(id)
    }
    if (frame.id !== undefined && frame.method) pending.set(requestKey(frame.id), frame)
    if (frame.method === 'session/prompt' && concreteId(id)) {
      const operation = frame.params?._meta?.['opl/clientRequestId']
      prompts.set(id, { operation: concreteId(operation) ? operation : undefined, bound: false })
    }
    if (lifecycle && concreteId(id) && frame.method !== 'session/close') {
      void shell.verify(id).then(
        () => {
          if (!closed && !input.writableEnded) input.write(line + '\n')
        },
        (error) => {
          busy.delete(id)
          prompts.delete(id)
          pending.delete(requestKey(frame.id))
          reject(frame.id, error)
        },
      )
    } else input.write(line + '\n')
  }

  const incoming = jsonLines(accept)
  incoming.on('finish', () => {
    closed = true
    input.end()
  })
  const outgoing = jsonLines((line) => {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      throw Error('Official ACP emitted invalid JSON.')
    }
    const request = frame.id === undefined ? undefined : pending.get(requestKey(frame.id))
    if (request && !frame.method) {
      pending.delete(requestKey(frame.id))
      const id = request.params?.sessionId
      if (id && ownsSession(request)) busy.delete(id)
      if (request.method === 'session/prompt') prompts.delete(id)
      if (!frame.error && request.method === 'initialize') {
        frame.result._meta = {
          ...frame.result._meta,
          'minimax-code/shell': shell.advertisement,
          'opl/session-history': historyCapability,
        }
      }
      if (
        !frame.error &&
        ['session/new', 'session/load', 'session/resume'].includes(request.method)
      )
        attached.add(frame.result.sessionId ?? id)
      if (!frame.error && request.method === 'session/close') attached.delete(id)
    }
    write(frame)
  })

  const original = runtime.sendMessage.bind(runtime)
  runtime.sendMessage = async function* (request, ...args) {
    const prompt = prompts.get(request.id)
    for await (const event of original(request, ...args)) {
      const m = event.type === 'message' ? event.message : undefined
      if (
        prompt?.operation &&
        !prompt.bound &&
        m?.role === 'user' &&
        m.turnId === request.turnId &&
        concreteId(m.id)
      ) {
        prompt.bound = true
        if (supportsNotifications)
          write({
            jsonrpc: '2.0',
            method: historyCapability.notifications[0],
            params: {
              sessionId: request.id,
              clientRequestId: prompt.operation,
              userMessageId: m.id,
              turnId: m.turnId,
            },
          })
      }
      yield event
    }
    if (
      closed ||
      !supportsNotifications ||
      !prompt?.bound ||
      !prompt.operation ||
      prompts.get(request.id) !== prompt ||
      !concreteId(request.turnId) ||
      typeof runtime.getSessionUsage !== 'function'
    )
      return
    // The official ACP context update omits these per-request token buckets.
    // Query its local usage service only after the native stream finishes.
    let timer
    try {
      const account = await Promise.race([
        runtime.getSessionUsage(request.id),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(undefined), 1000)
          timer.unref?.()
        }),
      ])
      if (closed || prompts.get(request.id) !== prompt || !Array.isArray(account?.rows)) return
      const rows = account.rows
        .filter((row) => row?.turnId === request.turnId)
        .map((row) =>
          Object.fromEntries(
            [
              'id',
              'turnId',
              'model',
              'inputTokens',
              'outputTokens',
              'reasoningTokens',
              'cacheReadTokens',
              'cacheWriteTokens',
            ]
              .filter((key) => row[key] !== undefined)
              .map((key) => [key, row[key]]),
          ),
        )
      if (rows.length)
        write({
          jsonrpc: '2.0',
          method: usageNotification,
          params: {
            version: 1,
            sessionId: request.id,
            operationId: prompt.operation,
            turnId: request.turnId,
            rows,
          },
        })
    } catch {
      // Optional local statistics must not fail or replay a completed model request.
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    input,
    incoming,
    output: outgoing,
    close() {
      closed = true
      input.destroy()
      incoming.destroy()
      outgoing.destroy()
      runtime.sendMessage = original
    },
  }
}
