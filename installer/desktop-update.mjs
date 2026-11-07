/** Private control of only the Desktop spawned by the Suite launcher. */
import { createServer, connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export async function atomicUpdateJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** Call the owned launcher without publishing its authentication fields. */
export async function requestDesktopUpdate(root, identity, method, input = {}) {
  const launch = JSON.parse(await readFile(join(root, 'desktop-launch.json'), 'utf8'))
  if (
    launch.schemaVersion !== 1 ||
    resolve(launch.profileHome) !== resolve(identity.profileHome) ||
    resolve(launch.application) !== resolve(identity.app) ||
    launch.suiteSha256 !== identity.suiteSha256 ||
    typeof launch.endpoint !== 'string' ||
    typeof launch.nonce !== 'string'
  )
    throw Error('Desktop update ownership is unavailable')
  return new Promise((accept, reject) => {
    const socket = connect(launch.endpoint)
    const timer = setTimeout(
      () => socket.destroy(Error('Desktop update response timed out')),
      method === 'prepare' ? 45_000 : 15_000,
    )
    let bytes = ''
    socket.setEncoding('utf8')
    socket.once('connect', () =>
      socket.end(JSON.stringify({ ...input, nonce: launch.nonce, method }) + '\n'),
    )
    socket.on('data', (chunk) => {
      bytes += chunk
      if (bytes.length > 64 * 1024) socket.destroy(Error('Desktop update response exceeded limit'))
    })
    socket.once('error', reject)
    socket.once('close', () => {
      clearTimeout(timer)
      try {
        const response = JSON.parse(bytes)
        if (!response.ok) throw Error('Desktop update request was refused')
        accept(response.value)
      } catch (error) {
        reject(error)
      }
    })
  })
}

/** Start a private authenticated pipe; no TCP port or public update action is exposed. */
export async function serveDesktopUpdate(root, identity, handler) {
  const nonce = randomUUID()
  const endpoint =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\opl-update-${process.pid}-${nonce}`
      : join(tmpdir(), `opl-update-${process.pid}-${nonce}.sock`)
  const sockets = new Set()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(15_000, () => socket.destroy())
    socket.setEncoding('utf8')
    let bytes = ''
    socket.on('data', (chunk) => {
      bytes += chunk
      if (bytes.length > 64 * 1024) socket.destroy()
    })
    socket.on('end', async () => {
      try {
        const request = JSON.parse(bytes)
        if (request.nonce !== nonce || !['inspect', 'prepare', 'handoff'].includes(request.method))
          throw Error('Unknown update caller')
        socket.setTimeout(request.method === 'prepare' ? 60_000 : 15_000)
        const response = await handler(request)
        const value = response?.afterReply ? response.value : response
        socket.end(JSON.stringify({ ok: true, value }) + '\n', () => response?.afterReply?.())
      } catch {
        socket.end(JSON.stringify({ ok: false }) + '\n')
      }
    })
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(endpoint, accept)
  })
  await mkdir(join(root, 'updates'), { recursive: true, mode: 0o700 })
  const record = {
    schemaVersion: 1,
    ...identity,
    nonce,
    endpoint,
    launcherPid: process.pid,
    startedAt: new Date().toISOString(),
  }
  await atomicUpdateJson(join(root, 'desktop-launch.json'), record)
  return {
    record,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((accept) => server.close(accept))
      const current = JSON.parse(
        await readFile(join(root, 'desktop-launch.json'), 'utf8').catch(() => '{}'),
      )
      if (current.nonce === nonce) await unlink(join(root, 'desktop-launch.json'))
    },
  }
}
