/** Installation boundaries around the original bundle; no external account is used. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { openSuperagent } from '../installer/superagent.mjs'

const digest = (text) => createHash('sha256').update(text).digest('hex')
test(
  'independent SuperAgent preparation preserves personal data and user settings',
  { skip: process.platform !== 'darwin' },
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'opl-superagent-test-'))
    const root = join(base, 'suite/superagent')
    const profile = join(root, 'home/profiles/desktop')
    const release = join(base, 'release')
    const app = join(base, 'Official.app')
    const personal = join(base, 'personal')
    const calls = join(base, 'calls')
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/control') {
        assert.equal(req.headers.authorization, 'Bearer fixture-control')
        res.end(
          JSON.stringify({
            ok: true,
            value: `http://127.0.0.1:${server.address().port}/#opl-setup`,
          }),
        )
        return
      }
      assert.equal(req.url, '/orchestrator/api/state')
      assert.equal(req.headers['x-orchestrator-request'], '1')
      res.end(JSON.stringify({ setup: { machine: { stateDir: join(root, 'state') } } }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      for (const path of [release, personal, join(app, 'Contents/MacOS')])
        await mkdir(path, { recursive: true })
      await writeFile(join(personal, 'sentinel'), 'personal data')
      await writeFile(
        join(app, 'Contents/MacOS/DeepSeek Harness'),
        `#!/bin/sh\nprintf '%s\\n' "$@" >> '${calls}'\n`,
        { mode: 0o700 },
      )
      await writeFile(join(release, 'opl.tgz'), 'opl')
      const name = 'dsh-superagent-123456789abc.tgz'
      await writeFile(join(release, name), 'superagent')
      const artifact = {
        name: 'opl.tgz',
        sha256: digest('opl'),
        suiteSha256: 'v1',
        superagent: { name, sha256: digest('superagent') },
      }
      await writeFile(join(release, 'artifact.json'), JSON.stringify(artifact))
      const installed = {
        app,
        release,
        suiteRoot: join(base, 'suite'),
        profileHome: personal,
        home: personal,
      }
      const start = async ({ home, root: instance }) => {
        assert.equal(home, join(root, 'home'))
        assert.equal(instance, root)
        await writeFile(
          join(profile, 'control.json'),
          JSON.stringify({
            pid: process.pid,
            token: 'fixture-control',
            endpoint: `http://127.0.0.1:${server.address().port}/control`,
          }),
        )
        return { pid: process.pid }
      }
      assert.deepEqual(await openSuperagent(installed, { start }), { state: 'opened' })
      const patch = join(profile, 'cordis.patch.yml')
      assert.match(await readFile(patch, 'utf8'), /dsh-superagent/)
      assert.match(await readFile(calls, 'utf8'), new RegExp(name))
      const beforeCalls = await readFile(calls, 'utf8')
      assert.deepEqual(await openSuperagent(installed, { start }), { state: 'running' })
      assert.equal(
        await readFile(calls, 'utf8'),
        beforeCalls,
        'a live profile must never be reinstalled',
      )
      await rm(join(profile, 'control.json'))
      await rm(join(root, 'launch.json'))
      await writeFile(patch, 'user configuration\n')
      await mkdir(join(root, 'state'), { recursive: true })
      await writeFile(join(root, 'state/sentinel'), 'ticket history')
      artifact.suiteSha256 = 'v2'
      await writeFile(join(release, 'artifact.json'), JSON.stringify(artifact))
      await openSuperagent(installed, { start })
      assert.equal(await readFile(patch, 'utf8'), 'user configuration\n')
      assert.equal(await readFile(join(root, 'state/sentinel'), 'utf8'), 'ticket history')
      assert.equal(await readFile(join(personal, 'sentinel'), 'utf8'), 'personal data')
      await writeFile(join(release, name), 'modified')
      await assert.rejects(openSuperagent(installed, { start }), /校验失败/)
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await rm(base, { recursive: true, force: true })
    }
  },
)

test(
  'unsupported platforms refuse before touching installation data',
  { skip: process.platform === 'darwin' },
  async () => {
    await assert.rejects(openSuperagent({}), /POSIX/)
  },
)
