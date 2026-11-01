import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

test('delegate and follow-up forward exact write ownership without changing permission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opl-scope-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    const parsed = JSON.parse(body)
    requests.push(parsed)
    res.end(
      JSON.stringify({
        ok: true,
        value: parsed.method === 'delegate' ? { id: 'harness-scope' } : { state: 'completed' },
      }),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await mkdir(join(root, 'profiles/desktop'), { recursive: true })
  await writeFile(
    join(root, 'profiles/desktop/control.json'),
    JSON.stringify({
      pid: process.pid,
      endpoint: `http://127.0.0.1:${server.address().port}`,
      token: 'fixture-only',
    }),
  )
  await cp(new URL('../installer/skill/control.mjs', import.meta.url), join(root, 'control.mjs'))
  await cp(
    new URL('../installer/windows-lifecycle.mjs', import.meta.url),
    join(root, 'windows-lifecycle.mjs'),
  )
  await writeFile(join(root, 'config.json'), JSON.stringify({ home: root, autoStart: false }))
  const prompt = join(root, 'prompt.txt'),
    scope = join(root, 'scope.json')
  await writeFile(prompt, 'scoped task')
  await writeFile(scope, JSON.stringify(['src/client', 'tests/client/a.ts']))
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'control.mjs'), ...args], {
        env: { ...process.env, CODEX_THREAD_ID: 'scope-cli-review' },
      })
      let stderr = ''
      child.stdout.resume()
      child.stderr.on('data', (data) => {
        stderr += data
      })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, stderr }))
    })
  const initial = [
    'delegate',
    '--combination',
    'minimax-code/MiniMax-M3.1-Flash',
    '--sandbox',
    'full-access',
    '--cwd',
    root,
    '--task',
    'scope-task',
    '--operation',
    'initial',
    '--prompt-file',
    prompt,
    '--write-scope-file',
    scope,
  ]
  const result = await run(initial)
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(requests[0].args.writeScope, ['src/client', 'tests/client/a.ts'])
  assert.equal(requests[0].args.sandbox, 'full-access')
  assert.equal(requests[0].args.origin.sessionId, 'scope-cli-review')
  const next = await run([
    'delegate-prompt',
    '--session',
    'harness-scope',
    '--operation',
    'follow-up',
    '--prompt-file',
    prompt,
    '--write-scope-file',
    scope,
  ])
  assert.equal(next.code, 0, next.stderr)
  assert.deepEqual(requests.find((r) => r.method === 'prompt').args.writeScope, [
    'src/client',
    'tests/client/a.ts',
  ])
  const before = requests.length
  await writeFile(scope, JSON.stringify([]))
  assert.notEqual((await run(initial)).code, 0)
  assert.equal(requests.length, before)
})
