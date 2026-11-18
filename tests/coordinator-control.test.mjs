/** Public coordination settings use the shipped helper and its ordinary authenticated Host RPC. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { readWakeSettings } from '../installer/skill/coordinator/feedback.mjs'

const PRIVATE = 'fixture-token-not-for-coordinator-output'

test('real helper requests only the public wake configuration and never prints other Host fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opl-coordinator-public-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = []
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + PRIVATE)
    let text = ''
    for await (const chunk of req) text += chunk
    requests.push(JSON.parse(text))
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        ok: true,
        value: {
          wakeTransport: 'codex-queue',
          wakeExecution: 'native',
          wakeExecutable: join(root, 'codex.exe'),
          wakeDistro: '',
          token: PRIVATE,
          paths: { privateFile: PRIVATE },
        },
      }),
    )
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise((done) => server.close(done)))
  const profile = 'opl-linux'
  await mkdir(join(root, 'profiles', profile), { recursive: true })
  await writeFile(
    join(root, 'profiles', profile, 'control.json'),
    JSON.stringify({
      pid: process.pid,
      endpoint: `http://127.0.0.1:${server.address().port}`,
      token: PRIVATE,
    }),
  )
  await cp(new URL('../installer/skill/control.mjs', import.meta.url), join(root, 'control.mjs'))
  await cp(
    new URL('../installer/windows-lifecycle.mjs', import.meta.url),
    join(root, 'windows-lifecycle.mjs'),
  )
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({ home: root, profile, autoStart: true, launcher: join(root, 'must-not-launch') }),
  )
  const result = await readWakeSettings({ controlPath: join(root, 'control.mjs') })
  assert.equal(result.status, 'available')
  assert.equal(result.queue.executable, join(root, 'codex.exe'))
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
  assert.deepEqual(requests, [
    { namespace: 'oplCoordination', method: 'coordination-status', args: {}, timeoutMs: 15000 },
  ])
})
