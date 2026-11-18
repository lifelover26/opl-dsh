/** Exercise the shipped helper against an authenticated Session API. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, cp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { ProjectStore } from '../installer/skill/coordinator/state.mjs'

test('a retry sends one prompt; changed content under the same operation is refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opl-dispatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let prompts = 0
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only')
    let body = ''
    for await (const part of req) body += part
    const data = JSON.parse(body)
    if (data.method === 'prompt') prompts++
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        ok: true,
        value:
          data.method === 'create'
            ? { sessionId: data.args.request.sessionId }
            : data.method === 'prompt'
              ? { accepted: true }
              : data.method === 'register'
                ? { task: data.args.request }
                : data.method === 'selectModel'
                  ? { selected: data.args.request }
                  : {},
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
      token: 'test-only',
    }),
  )
  await cp(new URL('../installer/skill/control.mjs', import.meta.url), join(root, 'control.mjs'))
  await cp(
    new URL('../installer/windows-lifecycle.mjs', import.meta.url),
    join(root, 'windows-lifecycle.mjs'),
  )
  await cp(
    new URL('../installer/skill/windows-acl.mjs', import.meta.url),
    join(root, 'windows-acl.mjs'),
  )
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({ home: root, ledger: join(root, 'ledger'), launcher: '/must-not-launch' }),
  )
  const prompt = join(root, 'prompt.txt')
  await writeFile(prompt, 'hello')
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          join(root, 'control.mjs'),
          'dispatch',
          '--task',
          'test',
          '--operation',
          'initial',
          '--cwd',
          root,
          '--prompt-file',
          prompt,
        ],
        { env: { ...process.env, CODEX_THREAD_ID: 'test-thread' } },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (x) => (stdout += x))
      child.stderr.on('data', (x) => (stderr += x))
      child.on('exit', (code) => resolve({ code, stdout, stderr }))
    })
  assert.equal((await run()).code, 0)
  assert.equal(prompts, 1)
  const again = await run()
  assert.equal(again.code, 0)
  assert.equal(JSON.parse(again.stdout).idempotent, true)
  assert.equal(prompts, 1)
  await writeFile(prompt, 'different')
  const conflict = await run()
  assert.notEqual(conflict.code, 0)
  assert.match(conflict.stderr, /operation ID/)
  assert.equal(prompts, 1)
})

test('dispatch preserves coordinator bindings on replay and rejects invalid new bindings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opl-dispatch-coordinator-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = []
  let onCreate
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only')
    let body = ''
    for await (const part of req) body += part
    const data = JSON.parse(body)
    requests.push(data.method)
    res.setHeader('content-type', 'application/json')
    if (data.method === 'create' && onCreate) {
      try {
        await onCreate()
      } catch (error) {
        res.end(JSON.stringify({ ok: false, error: error.message }))
        return
      }
    }
    res.end(
      JSON.stringify({
        ok: true,
        value:
          data.method === 'create'
            ? { sessionId: data.args.request.sessionId }
            : data.method === 'prompt'
              ? { accepted: true }
              : data.method === 'register'
                ? { task: data.args.request }
                : data.method === 'selectModel'
                  ? { selected: data.args.request }
                  : {},
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
      token: 'test-only',
    }),
  )
  await cp(new URL('../installer/skill/control.mjs', import.meta.url), join(root, 'control.mjs'))
  await cp(new URL('../installer/skill/coordinator', import.meta.url), join(root, 'coordinator'), {
    recursive: true,
  })
  await cp(
    new URL('../installer/windows-lifecycle.mjs', import.meta.url),
    join(root, 'windows-lifecycle.mjs'),
  )
  await cp(
    new URL('../installer/skill/windows-acl.mjs', import.meta.url),
    join(root, 'windows-acl.mjs'),
  )
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({ home: root, ledger: join(root, 'ledger'), launcher: '/must-not-launch' }),
  )
  const prompt = join(root, 'prompt.txt')
  await writeFile(prompt, 'hello')
  const store = new ProjectStore({ root: join(root, 'opl-dsh-coordinator', 'projects') })
  await store.init({
    projectId: 'coordinator-project',
    cwd: root,
    threadId: 'test-thread',
    authorization: 'test authorization',
    workItems: [
      { workId: 'first', dependsOn: [], acceptance: 'first acceptance' },
      { workId: 'second', dependsOn: ['first'], acceptance: 'second acceptance' },
      { workId: 'third', dependsOn: [], acceptance: 'third acceptance' },
    ],
  })
  const run = (work, operation = 'initial') =>
    new Promise((resolve) => {
      const args = [
        join(root, 'control.mjs'),
        'dispatch',
        '--task',
        'test',
        '--operation',
        operation,
        '--cwd',
        root,
        '--prompt-file',
        prompt,
      ]
      if (work !== undefined) args.push('--coordinator-work', work)
      const child = spawn(process.execPath, args, {
        env: { ...process.env, CODEX_THREAD_ID: 'test-thread', OPL_CODEX_HOME: root },
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (x) => (stdout += x))
      child.stderr.on('data', (x) => (stderr += x))
      child.on('exit', (code) => resolve({ code, stdout, stderr }))
    })

  const first = await run('first')
  assert.equal(first.code, 0, first.stderr)
  const firstReceipt = JSON.parse(first.stdout)
  assert.deepEqual(firstReceipt.coordinator, {
    status: 'bound',
    projectId: 'coordinator-project',
    workId: 'first',
  })
  assert.deepEqual(requests, ['create', 'selectModel', 'register', 'prompt'])

  const replay = await run('first')
  assert.equal(replay.code, 0, replay.stderr)
  const replayReceipt = JSON.parse(replay.stdout)
  assert.equal(replayReceipt.idempotent, true)
  assert.deepEqual(replayReceipt.coordinator, firstReceipt.coordinator)
  assert.deepEqual(requests, ['create', 'selectModel', 'register', 'prompt'])

  const changed = await run('second')
  assert.notEqual(changed.code, 0)
  assert.match(changed.stderr, /operation ID/)
  const omitted = await run(undefined)
  assert.notEqual(omitted.code, 0)
  assert.match(omitted.stderr, /operation ID/)
  assert.deepEqual(requests, ['create', 'selectModel', 'register', 'prompt'])

  const state = await store.get('coordinator-project')
  assert.deepEqual(
    state.workItems.map(({ workId, taskId, operationId }) => ({
      workId,
      ...(taskId ? { taskId } : {}),
      ...(operationId ? { operationId } : {}),
    })),
    [
      {
        workId: 'first',
        taskId: firstReceipt.taskId,
        operationId: 'initial',
      },
      { workId: 'second' },
      { workId: 'third' },
    ],
  )

  const ledger = join(root, 'ledger')
  assert.deepEqual(await readdir(ledger), [`${firstReceipt.requestId}.json`])
  for (const [work, operation, error] of [
    ['missing', 'missing-work', /work item is not registered/],
    ['second', 'blocked-work', /task cannot bind to this registered work item/],
  ]) {
    const denied = await run(work, operation)
    assert.notEqual(denied.code, 0)
    assert.match(denied.stderr, error)
    assert.equal(denied.stdout, '')
    assert.deepEqual(requests, ['create', 'selectModel', 'register', 'prompt'])
    assert.deepEqual(await readdir(ledger), [`${firstReceipt.requestId}.json`])
    assert.deepEqual(await store.get('coordinator-project'), state)
  }

  onCreate = async () => {
    const paused = await store.apply('coordinator-project', {
      eventId: 'pause-during-dispatch',
      type: 'project.pause',
      reason: 'test pause during dispatch',
      authorityEpoch: state.authorityEpoch,
    })
    await store.apply('coordinator-project', {
      eventId: 'resume-during-dispatch',
      type: 'project.resume',
      reason: 'test resume during dispatch',
      authorityEpoch: paused.authorityEpoch,
    })
  }
  const requestCount = requests.length
  const stale = await run('third', 'stale-authority')
  assert.notEqual(stale.code, 0)
  assert.match(stale.stderr, /project authorization epoch has changed/)
  assert.equal(stale.stdout, '')
  const staleRequests = requests.slice(requestCount)
  assert.equal(staleRequests[0], 'create')
  assert.equal(staleRequests.includes('prompt'), false)
  const resumed = await store.get('coordinator-project')
  assert.equal(resumed.mode, 'active')
  assert.equal(resumed.authorityEpoch, state.authorityEpoch + 2)
  assert.deepEqual(resumed.workItems, state.workItems)
})

test('delegate-wait returns the persisted snapshot when the control deadline expires', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opl-wait-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    const data = JSON.parse(body)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        data.method === 'wait'
          ? { ok: false, error: 'control call timed out' }
          : { ok: true, value: { id: 'harness-one', state: 'running' } },
      ),
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
      token: 'test-only',
    }),
  )
  await cp(new URL('../installer/skill/control.mjs', import.meta.url), join(root, 'control.mjs'))
  await cp(
    new URL('../installer/windows-lifecycle.mjs', import.meta.url),
    join(root, 'windows-lifecycle.mjs'),
  )
  await cp(
    new URL('../installer/skill/windows-acl.mjs', import.meta.url),
    join(root, 'windows-acl.mjs'),
  )
  await writeFile(join(root, 'config.json'), JSON.stringify({ home: root, autoStart: false }))
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      join(root, 'control.mjs'),
      'delegate-wait',
      '--session',
      'harness-one',
    ])
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (part) => (stdout += part))
    child.stderr.on('data', (part) => (stderr += part))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { id: 'harness-one', state: 'running' })
})
