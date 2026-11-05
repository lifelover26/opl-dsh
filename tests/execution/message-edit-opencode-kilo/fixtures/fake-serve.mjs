#!/usr/bin/env node
/**
 * Local keyless stand-in for `opencode serve` / `kilo serve` used by the driver's focused
 * control-path test. It never calls a provider; it serves public status/history/fork routes
 * and enforces the same Basic authentication as the official CLI.
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const kind = process.env.FAKE_VENDOR_KIND === 'kilo' ? 'kilo' : 'opencode'
const passwordEnv = kind === 'kilo' ? 'KILO_SERVER_PASSWORD' : 'OPENCODE_SERVER_PASSWORD'
const usernameEnv = kind === 'kilo' ? 'KILO_SERVER_USERNAME' : 'OPENCODE_SERVER_USERNAME'
const password = process.env[passwordEnv] ?? ''
const username = process.env[usernameEnv] ?? (kind === 'kilo' ? 'kilo' : 'opencode')
const pidFile = process.env.FAKE_PID_FILE
if (pidFile) writeFileSync(pidFile, String(process.pid))
if (process.env.FAKE_EXIT_EARLY === '1') process.exit(2)

let sequence = 1
const next = (prefix) => `${prefix}_${sequence++}`
const sessions = new Map()
const initial = process.env.FAKE_VENDOR_MESSAGES ? JSON.parse(process.env.FAKE_VENDOR_MESSAGES) : []
sessions.set('ses_current', initial)
// The official process-local status list omits idle sessions.
const statuses = process.env.FAKE_VENDOR_STATUSES
  ? JSON.parse(process.env.FAKE_VENDOR_STATUSES)
  : {}

function remap(prefix, sessionId) {
  const ids = new Map(
    prefix.map((message, index) => [message.info.id, next(`msg_${sessionId}_${index}`)]),
  )
  return prefix.map((message) => {
    const info = { ...message.info, id: ids.get(message.info.id), sessionID: sessionId }
    if (typeof info.parentID === 'string') info.parentID = ids.get(info.parentID)
    const parts = message.parts.map((part) => {
      const copy = {
        ...part,
        id: next(`prt_${sessionId}`),
        messageID: info.id,
        sessionID: sessionId,
      }
      if (copy.type === 'compaction' && typeof copy.tail_start_id === 'string')
        copy.tail_start_id = ids.get(copy.tail_start_id)
      return copy
    })
    return { info, parts }
  })
}

const expected = password
  ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  : undefined

const server = createServer(async (request, response) => {
  if (expected && request.headers.authorization !== expected) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":"unauthorized"}')
    return
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/doc') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
    return
  }
  if (request.method === 'GET' && url.pathname === '/session/status') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(statuses))
    return
  }
  const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/)
  if (request.method === 'GET' && messageMatch) {
    const messages = sessions.get(decodeURIComponent(messageMatch[1]))
    if (!messages) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(messages))
    return
  }
  const forkMatch = url.pathname.match(/^\/session\/([^/]+)\/fork$/)
  if (request.method === 'POST' && forkMatch) {
    if (process.env.FAKE_FORK_ENTERED_FILE)
      writeFileSync(process.env.FAKE_FORK_ENTERED_FILE, 'entered')
    const body = await new Promise((resolveBody) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => resolveBody(raw))
    })
    const source = sessions.get(decodeURIComponent(forkMatch[1]))
    if (!source) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }
    let messageID
    try {
      messageID = JSON.parse(body).messageID
    } catch {}
    if (process.env.FAKE_FORK_DELAY_MS)
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, Number(process.env.FAKE_FORK_DELAY_MS)),
      )
    const index = source.findIndex((message) => message.info.id === messageID)
    const prefix = index < 0 ? source : source.slice(0, index)
    const forkId = `ses_fake_${next('fork')}`
    sessions.set(forkId, remap(prefix, forkId))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: forkId }))
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end('{"error":"not found"}')
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  console.log(`${kind} server listening on http://127.0.0.1:${port}`)
})

for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)))
