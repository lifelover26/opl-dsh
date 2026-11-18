/** CLI and Hook installation tests use temporary homes and an injected runtime, never a live backend. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { watch as watchFile } from 'node:fs'
import { main, resolveNodeRuntime } from '../installer/skill/coordinator/cli.mjs'
import { ProjectStore } from '../installer/skill/coordinator/state.mjs'

const PRIVATE = 'private-model-task-credential-and-error'
const execFileAsync = promisify(execFile)

function waitJson(root, filename, predicate) {
  return new Promise((resolve, reject) => {
    let finished = false
    const done = (error, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      watcher.close()
      error ? reject(error) : resolve(value)
    }
    const check = async () => {
      try {
        const value = JSON.parse(await readFile(join(root, filename), 'utf8'))
        if (predicate(value)) done(null, value)
      } catch (error) {
        if (error.code !== 'ENOENT') done(error)
      }
    }
    const watcher = watchFile(root, () => {
      check()
    })
    watcher.on('error', (error) => done(error))
    const timer = setTimeout(() => done(new Error('watcher-handshake-timeout')), 15000)
    check()
  })
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "opl-coordinator-cli owner's-"))
  t.after(() => rm(base, { recursive: true, force: true }))
  const codexHome = join(base, 'codex home'),
    root = join(base, 'coordinator state')
  await mkdir(codexHome)
  const calls = [],
    launchCalls = []
  class Runtime {
    constructor(options) {
      calls.push(['constructor', options])
      this.store = {
        transaction: async (_projectId, action) => action(),
        apply: async (...args) => {
          calls.push(['apply', ...args])
          return { status: 'applied', evidence: PRIVATE }
        },
      }
    }
    async init(spec) {
      calls.push(['init', spec])
      return { ...spec, authorityEpoch: 1 }
    }
    async status(project) {
      calls.push(['status', project])
      return { projectId: project, status: 'active' }
    }
    async hook(observation) {
      calls.push(['hook', observation])
      return { status: 'ok' }
    }
    async reconcile(project) {
      calls.push(['reconcile', project])
      return { projectId: project, status: 'reconciled' }
    }
    async acknowledge(...args) {
      calls.push(['ack', ...args])
      return { status: 'received' }
    }
    async reviewAction(...args) {
      calls.push(['review-action', ...args])
      return { status: 'accepted', replayed: false }
    }
    async pause(...args) {
      calls.push(['pause', ...args])
      return { status: 'paused' }
    }
    async resume(...args) {
      calls.push(['resume', ...args])
      return { status: 'active' }
    }
    async watch(options) {
      calls.push(['watch', options])
      return { status: 'watch-stopped' }
    }
  }
  const run = async (args, options = {}) => {
    let stdout = '',
      stderr = ''
    const code = await main([...args, '--root', root, '--codex-home', codexHome], {
      Coordinator: Runtime,
      stdin: Readable.from([]),
      stdout: {
        write: (chunk) => {
          stdout += chunk
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += chunk
        },
      },
      launch: async (options) => {
        launchCalls.push(options)
        return { pid: 123456, method: 'stub', guarantee: 'test' }
      },
      probe: async () => 'alive',
      ...options,
    })
    return { code, stdout, stderr }
  }
  const plan = {
    projectId: 'exact-project',
    cwd: base,
    threadId: 'exact-thread',
    authorization: PRIVATE,
    workItems: [{ workId: 'work-a', dependsOn: [], acceptance: PRIVATE }],
  }
  const planFile = join(base, 'plan.json')
  await writeFile(planFile, JSON.stringify(plan))
  return { base, root, codexHome, calls, launchCalls, Runtime, run, plan, planFile }
}

test('init keeps local metadata settings while DSH owns the queue configuration', async (t) => {
  const f = await fixture(t)
  const connection = {
    controlPath: join(f.base, 'installed Skill/control.mjs'),
    feedbackWatchPaths: [join(f.base, 'feedback metadata.json')],
  }
  await writeFile(f.planFile, JSON.stringify({ ...f.plan, connection }))
  const result = await f.run(['init', '--file', f.planFile])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.includes(PRIVATE), false)
  const saved = JSON.parse(await readFile(join(f.root, 'settings.json'), 'utf8'))
  assert.equal(saved.codexHome, f.codexHome)
  assert.equal(saved.controlPath, connection.controlPath)
  assert.equal(Object.hasOwn(saved, 'queue'), false)
  assert.deepEqual(saved.feedbackWatchPaths, connection.feedbackWatchPaths)
  assert.equal(JSON.stringify(saved).includes(PRIVATE), false)
  assert.equal(f.calls[1][1].connection, undefined)
  f.calls.length = 0
  assert.equal((await f.run(['status', '--project', 'exact-project'])).code, 0)
  assert.equal(Object.hasOwn(f.calls[0][1], 'queue'), false)
})

test('missing queue settings remain unconnected without discovering executables or credentials', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.run(['init', '--file', f.planFile])).code, 0)
  const saved = JSON.parse(await readFile(join(f.root, 'settings.json'), 'utf8'))
  assert.equal(Object.hasOwn(saved, 'queue'), false)
  assert.deepEqual(saved.feedbackWatchPaths, [])
  assert.equal(saved.controlPath.endsWith('control.mjs'), true)
  assert.equal((await f.run(['status'])).code, 0)
  assert.deepEqual(f.calls.at(-1), ['status', undefined])
})

test('connection and saved configuration reject extra credential fields before invoking runtime', async (t) => {
  const f = await fixture(t)
  for (const connection of [
    { token: PRIVATE },
    { controlPath: 'relative-control.mjs' },
    { feedbackWatchPaths: ['relative-state.json'] },
    { wake: { wakeTransport: 'unconnected', token: PRIVATE } },
    { wake: { wakeTransport: 'codex-queue', wakeExecution: 'native', wakeExecutable: 'codex' } },
  ]) {
    f.calls.length = 0
    await writeFile(f.planFile, JSON.stringify({ ...f.plan, connection }))
    const result = await f.run(['init', '--file', f.planFile])
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes(PRIVATE), false)
    assert.deepEqual(f.calls, [])
  }
  await mkdir(f.root, { recursive: true })
  await writeFile(
    join(f.root, 'settings.json'),
    JSON.stringify({ schemaVersion: 1, token: PRIVATE }),
  )
  assert.equal((await f.run(['status'])).code, 1)
})

test('project commands preserve exact identifiers, epochs and event files', async (t) => {
  const f = await fixture(t),
    eventFile = join(f.base, 'event.json')
  const event = {
    eventId: 'exact-event',
    type: 'feedback.consumed',
    authorityEpoch: 4,
    deliveryId: 'opaque@delivery',
  }
  await writeFile(eventFile, JSON.stringify(event))
  for (const args of [
    ['pause', '--project', 'exact-project', '--reason', 'user-paused'],
    ['resume', '--project', 'exact-project', '--reason', 'user-resumed'],
    ['reconcile', '--project', 'exact-project'],
    ['ack', '--project', 'exact-project', '--intent', 'exact-intent', '--epoch', '4'],
    ['apply', '--project', 'exact-project', '--file', eventFile],
    ['watch', '--project', 'exact-project'],
  ])
    assert.equal((await f.run(args)).code, 0)
  assert.ok(
    f.calls.some(
      (call) =>
        JSON.stringify(call) === JSON.stringify(['ack', 'exact-project', 'exact-intent', 4]),
    ),
  )
  assert.ok(
    f.calls.some(
      (call) => JSON.stringify(call) === JSON.stringify(['apply', 'exact-project', event]),
    ),
  )
  assert.ok(
    f.calls.some(
      (call) =>
        call[0] === 'watch' &&
        call[1].projectId === 'exact-project' &&
        call[1].signal instanceof AbortSignal,
    ),
  )
  for (const args of [
    ['watch'],
    ['ack', '--project', 'p', '--intent', 'i', '--epoch', '0'],
    ['ack', '--project', 'p', '--intent', 'i', '--epoch', '1.5'],
    ['status', '--unknown', PRIVATE],
    ['status', '--project', 'p', '--project', 'q'],
  ]) {
    const result = await f.run(args)
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes(PRIVATE), false)
  }
})

test('Hook stdin is bounded, drops private bodies and writes only official output JSON', async (t) => {
  const f = await fixture(t)
  class HookRuntime extends f.Runtime {
    async hook(observation) {
      f.calls.push(['hook', observation])
      return {
        status: 'ok',
        reason: PRIVATE,
        output: { decision: 'block', reason: 'continue-intent-a' },
      }
    }
  }
  const hook = {
    hook_event_name: 'Stop',
    session_id: 'exact-thread',
    turn_id: 'turn-a',
    cwd: f.base,
    stop_hook_active: false,
    prompt: PRIVATE,
    arbitrary: PRIVATE,
  }
  const result = await f.run(['hook'], {
    Coordinator: HookRuntime,
    stdin: Readable.from([JSON.stringify(hook)]),
  })
  assert.equal(result.stdout, '{"decision":"block","reason":"continue-intent-a"}\n')
  assert.equal(result.stderr, '')
  assert.equal(JSON.stringify(f.calls).includes(PRIVATE), false)
  for (const input of ['invalid:' + PRIVATE, ' '.repeat(1024 * 1024 + 1)]) {
    const invalid = await f.run(['hook'], {
      Coordinator: HookRuntime,
      stdin: Readable.from([input]),
    })
    assert.equal(invalid.stdout, '')
    assert.equal(invalid.code, 0)
  }
})

test('runtime and parsing failures return one short diagnostic without raw errors', async (t) => {
  const f = await fixture(t)
  class Failing extends f.Runtime {
    async status() {
      throw new Error(PRIVATE)
    }
  }
  const failed = await f.run(['status'], { Coordinator: Failing })
  assert.equal(failed.code, 1)
  assert.equal(failed.stdout, '')
  assert.equal(failed.stderr, '协调命令失败；请检查参数、项目状态和已保存配置。\n')
  await writeFile(f.planFile, 'bad json:' + PRIVATE)
  assert.deepEqual(await f.run(['init', '--file', f.planFile]), failed)
})

test('review-action forwards exact current review identity and rejects caller action IDs', async (t) => {
  const f = await fixture(t),
    requestFile = join(f.base, 'review request.json'),
    identity = {
      reviewRunId: 'review@exact',
      consumerId: 'chief@exact',
      claimEpoch: 3,
      authorityEpoch: 7,
    }
  for (const request of [
    {
      ...identity,
      kind: 'review',
      decision: 'accepted',
      noteFile: join(f.base, 'review-note.txt'),
    },
    { ...identity, kind: 'consume' },
  ]) {
    await writeFile(requestFile, JSON.stringify(request))
    const result = await f.run([
      'review-action',
      '--project',
      'exact-project',
      '--file',
      requestFile,
    ])
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), { status: 'accepted', replayed: false })
    assert.deepEqual(f.calls.at(-1), ['review-action', 'exact-project', request])
  }
  const before = f.calls.filter((call) => call[0] === 'review-action').length
  for (const request of [
    { ...identity, kind: 'consume', actionId: 'caller-retry-id' },
    { ...identity, kind: 'consume', authorityEpoch: 0 },
    { ...identity, kind: 'review', decision: 'accepted', noteFile: 'relative.txt' },
    { ...identity, kind: 'review', decision: 'accepted' },
    { ...identity, kind: 'review', decision: 'unknown', noteFile: join(f.base, 'note.txt') },
  ]) {
    await writeFile(requestFile, JSON.stringify(request))
    const result = await f.run([
      'review-action',
      '--project',
      'exact-project',
      '--file',
      requestFile,
    ])
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /\[invalid-review-action\]/)
  }
  assert.equal(f.calls.filter((call) => call[0] === 'review-action').length, before)
  for (const args of [
    ['review-action', '--file', requestFile],
    ['review-action', '--project', 'p'],
  ])
    assert.equal((await f.run(args)).code, 1)
})

test('diagnostics expose only known codes and never raw runtime or Host text', async (t) => {
  const f = await fixture(t)
  for (const [error, code] of [
    [Object.assign(new Error(PRIVATE), { code: 'STALE_RUN' }), 'STALE_RUN'],
    [new Error('review-feedback-unavailable'), 'review-feedback-unavailable'],
    [Object.assign(new Error(PRIVATE), { code: PRIVATE }), null],
    [new Error('host-private-body'), null],
  ]) {
    class Failing extends f.Runtime {
      async status() {
        throw error
      }
    }
    const result = await f.run(['status'], { Coordinator: Failing })
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.equal(
      result.stderr,
      `协调命令失败${code ? ' [' + code + ']' : ''}；请检查参数、项目状态和已保存配置。\n`,
    )
  }
})

test('Hook installation merges seven owned handlers, backs up exact bytes and leaves trust untouched', async (t) => {
  const f = await fixture(t),
    hooksPath = join(f.codexHome, 'hooks.json')
  const original =
    '{"custom":true,"hooks":{"Stop":[{"hooks":[{"type":"command","command":"foreign-never-execute"}]}]}}\r\n'
  await writeFile(hooksPath, original)
  const trustPath = join(f.codexHome, 'hook-trust.json')
  await writeFile(trustPath, PRIVATE)
  const installed = await f.run([
    'install-hooks',
    '--shell',
    'git-bash',
    '--node',
    process.execPath,
  ])
  assert.equal(installed.code, 0)
  assert.equal(JSON.parse(installed.stdout).requiresTrust, true)
  assert.equal(f.calls.length, 0)
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8'))
  assert.equal(Object.keys(hooks.hooks).length, 7)
  assert.equal(hooks.hooks.Stop.length, 2)
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'foreign-never-execute')
  assert.match(hooks.hooks.Stop[1].hooks[0].commandWindows, /^powershell.exe .* -EncodedCommand /)
  assert.equal(await readFile(trustPath, 'utf8'), PRIVATE)
  const metadata = JSON.parse(await readFile(join(f.root, 'hooks-installation.json'), 'utf8'))
  assert.equal(metadata.backups[0].originalText, original)
  assert.equal(
    JSON.parse(await readFile(join(f.root, 'settings.json'), 'utf8')).nodePath,
    process.execPath,
  )
  const again = await f.run(['install-hooks', '--shell', 'git-bash', '--node', process.execPath])
  assert.equal(JSON.parse(again.stdout).status, 'unchanged')
  assert.equal((await f.run(['remove-hooks'])).code, 0)
  assert.equal(await readFile(hooksPath, 'utf8'), original)
  assert.equal(await readFile(trustPath, 'utf8'), PRIVATE)
  assert.equal(JSON.parse((await f.run(['remove-hooks'])).stdout).status, 'not-installed')
})

test('guided setup installs Hooks once and records the trust handoff without writing trust state', async (t) => {
  const f = await fixture(t),
    hooksPath = join(f.codexHome, 'hooks.json'),
    trustPath = join(f.codexHome, 'hook-trust.json')
  await writeFile(trustPath, PRIVATE)
  const result = await f.run(['setup', '--shell', 'git-bash', '--node', process.execPath])
  assert.equal(result.code, 0)
  const output = JSON.parse(result.stdout)
  assert.equal(output.requiresTrust, true)
  assert.equal(output.next, 'open-codex-hooks-settings')
  assert.equal(output.setupState.hooksInstalled, true)
  assert.equal(output.setupState.trustStatus, 'managed-by-codex')
  assert.equal(Object.hasOwn(output.setupState, 'trustConfirmed'), false)
  assert.equal(Object.hasOwn(output.setupState, 'firstRunCompleted'), false)
  assert.equal(await readFile(trustPath, 'utf8'), PRIVATE)
  const setup = JSON.parse(await readFile(join(f.root, 'setup-state.json'), 'utf8'))
  assert.deepEqual(setup, output.setupState)
  assert.equal(Object.keys(JSON.parse(await readFile(hooksPath, 'utf8')).hooks).length, 7)
  await writeFile(
    join(f.root, 'setup-state.json'),
    JSON.stringify({ ...setup, trustConfirmed: true, firstRunCompleted: true }),
  )
  const again = await f.run(['setup', '--shell', 'git-bash', '--node', process.execPath])
  assert.equal(JSON.parse(again.stdout).status, 'unchanged')
  const updated = JSON.parse(await readFile(join(f.root, 'setup-state.json'), 'utf8'))
  assert.equal(updated.trustStatus, 'managed-by-codex')
  assert.equal(Object.hasOwn(updated, 'trustConfirmed'), false)
  assert.equal(Object.hasOwn(updated, 'firstRunCompleted'), false)
  assert.equal(await readFile(trustPath, 'utf8'), PRIVATE)
})

test('guided setup retains malformed installation records instead of overwriting them', async (t) => {
  const f = await fixture(t)
  const statePath = join(f.root, 'setup-state.json')
  await mkdir(f.root, { recursive: true })
  await writeFile(statePath, '{invalid:' + PRIVATE)
  const result = await f.run(['setup', '--shell', 'git-bash', '--node', process.execPath])
  assert.equal(result.code, 1)
  assert.equal(await readFile(statePath, 'utf8'), '{invalid:' + PRIVATE)
  assert.ok(!result.stderr.includes(PRIVATE))
})

test('Hook removal preserves foreign changes and customized owned handlers', async (t) => {
  const f = await fixture(t),
    hooksPath = join(f.codexHome, 'hooks.json')
  assert.equal((await f.run(['install-hooks', '--shell', 'powershell'])).code, 0)
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8'))
  assert.match(hooks.hooks.Stop[0].hooks[0].commandWindows, /^powershell.exe .* -EncodedCommand /)
  hooks.custom = PRIVATE
  hooks.hooks.Stop[0].hooks[0].timeout = 12
  hooks.hooks.Interrupt[0].hooks.push({ type: 'command', command: 'foreign-later' })
  await writeFile(hooksPath, JSON.stringify(hooks))
  const removed = await f.run(['remove-hooks'])
  assert.equal(removed.code, 0)
  assert.equal(removed.stdout.includes(PRIVATE), false)
  const remaining = JSON.parse(await readFile(hooksPath, 'utf8'))
  assert.equal(remaining.custom, PRIVATE)
  assert.equal(remaining.hooks.Stop[0].hooks[0].timeout, 12)
  assert.deepEqual(remaining.hooks.Interrupt[0].hooks, [
    { type: 'command', command: 'foreign-later' },
  ])
  assert.equal(Object.keys(remaining.hooks).length, 2)
})

test('legacy Hook shell selection retains one fixed Windows launcher and the earliest foreign configuration', async (t) => {
  const f = await fixture(t),
    hooksPath = join(f.codexHome, 'hooks.json')
  await writeFile(hooksPath, '{"original":"setting"}\n')
  assert.equal((await f.run(['install-hooks', '--shell', 'git-bash'])).code, 0)
  assert.equal(
    JSON.parse((await f.run(['install-hooks', '--shell', 'powershell'])).stdout).status,
    'unchanged',
  )
  const current = JSON.parse(await readFile(hooksPath, 'utf8'))
  assert.equal(current.hooks.Stop.length, 1)
  assert.match(current.hooks.Stop[0].hooks[0].commandWindows, /^powershell.exe .* -EncodedCommand /)
  assert.equal((await f.run(['remove-hooks'])).code, 0)
  assert.equal(await readFile(hooksPath, 'utf8'), '{"original":"setting"}\n')
})

test('Hook upgrades retain disabled state keys and foreign positions across every event', async (t) => {
  const f = await fixture(t),
    hooksPath = join(f.codexHome, 'hooks.json')
  assert.equal((await f.run(['install-hooks', '--shell', 'git-bash'])).code, 0)
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8'))
  const metadataPath = join(f.root, 'hooks-installation.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  const disabled = new Map(),
    positions = new Map()
  const labels = {
    SessionStart: 'session_start',
    UserPromptSubmit: 'user_prompt_submit',
    Stop: 'stop',
    Interrupt: 'interrupt',
    PreModelRequest: 'pre_model_request',
    PostModelRequest: 'post_model_request',
    SessionEnd: 'session_end',
  }
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    const owned = groups[0].hooks[0]
    owned.commandWindows = `legacy-command-${event}`
    metadata.backups.at(-1).owned.hooks[event][0].hooks[0].commandWindows = owned.commandWindows
    groups[0].hooks.unshift({ type: 'command', command: `foreign-mixed-${event}` })
    groups.unshift({ matcher: 'foreign', hooks: [{ type: 'command', command: `before-${event}` }] })
    groups.push({ hooks: [{ type: 'command', command: `after-${event}` }] })
    const key = `${hooksPath}:${labels[event]}:1:1`
    disabled.set(key, false)
    positions.set(event, {
      key,
      owned,
      before: structuredClone(groups[0]),
      after: structuredClone(groups[2]),
    })
  }
  await writeFile(hooksPath, JSON.stringify(hooks))
  await writeFile(metadataPath, JSON.stringify(metadata))
  const configPath = join(f.codexHome, 'config.toml')
  const config = [...disabled]
    .map(([key]) => `[hooks.state.${JSON.stringify(key)}]\nenabled = false\n`)
    .join('\n')
  await writeFile(configPath, config)
  const result = JSON.parse((await f.run(['install-hooks', '--shell', 'powershell'])).stdout)
  assert.equal(result.status, 'installed')
  const updated = JSON.parse(await readFile(hooksPath, 'utf8'))
  for (const [event, { key, owned, before, after }] of positions) {
    const groups = updated.hooks[event]
    assert.equal(groups.length, 3)
    assert.deepEqual(groups[0], before)
    assert.deepEqual(groups[2], after)
    assert.equal(groups[1].hooks.length, 2)
    assert.equal(groups[1].hooks[0].command, `foreign-mixed-${event}`)
    assert.notEqual(groups[1].hooks[1].commandWindows, owned.commandWindows)
    assert.equal(`${hooksPath}:${labels[event]}:1:1`, key)
    assert.equal(disabled.get(key), false)
  }
  assert.equal(await readFile(configPath, 'utf8'), config)
  const bytes = await readFile(hooksPath, 'utf8')
  assert.equal(
    JSON.parse((await f.run(['install-hooks', '--shell', 'powershell'])).stdout).status,
    'unchanged',
  )
  assert.equal(await readFile(hooksPath, 'utf8'), bytes)
})

test('Hook upgrades and setup preserve customized, missing and duplicate handlers for review', async (t) => {
  for (const change of ['timeout', 'matcher', 'missing', 'duplicate', 'duplicate-customized']) {
    const f = await fixture(t),
      hooksPath = join(f.codexHome, 'hooks.json')
    assert.equal((await f.run(['install-hooks', '--shell', 'git-bash'])).code, 0)
    const hooks = JSON.parse(await readFile(hooksPath, 'utf8'))
    if (change === 'timeout') hooks.hooks.Stop[0].hooks[0].timeout = 12
    if (change === 'matcher') hooks.hooks.Stop[0].matcher = 'user'
    if (change === 'missing') delete hooks.hooks.Stop
    if (change.startsWith('duplicate')) {
      const duplicate = structuredClone(hooks.hooks.Stop[0])
      if (change === 'duplicate-customized') duplicate.hooks[0].timeout = 12
      hooks.hooks.Stop.push(duplicate)
    }
    const bytes = JSON.stringify(hooks)
    await writeFile(hooksPath, bytes)
    const metadataPath = join(f.root, 'hooks-installation.json')
    const metadata = await readFile(metadataPath, 'utf8')
    const settingsPath = join(f.root, 'settings.json')
    const settings = await readFile(settingsPath, 'utf8')
    const statePath = join(f.root, 'setup-state.json')
    const state = JSON.stringify({ custom: PRIVATE, requiresTrust: false })
    await writeFile(statePath, state)
    for (const command of ['install-hooks', 'setup']) {
      const result = await f.run([command, '--shell', 'powershell', '--node', process.execPath])
      assert.equal(result.code, 0)
      assert.equal(JSON.parse(result.stdout).status, 'needs-repair', change)
      assert.equal(JSON.parse(result.stdout).requiresTrust, false)
      assert.equal(await readFile(hooksPath, 'utf8'), bytes)
      assert.equal(await readFile(metadataPath, 'utf8'), metadata)
      assert.equal(await readFile(settingsPath, 'utf8'), settings)
      assert.equal(await readFile(statePath, 'utf8'), state)
    }
  }
})

test('customized commands without installation metadata are retained without duplicate installation', async (t) => {
  const f = await fixture(t),
    hooksPath = join(f.codexHome, 'hooks.json')
  await f.run(['install-hooks', '--shell', 'git-bash'])
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8'))
  hooks.hooks.Stop[0].hooks[0].timeout = 12
  const bytes = JSON.stringify(hooks)
  await writeFile(hooksPath, bytes)
  await rm(join(f.root, 'hooks-installation.json'))
  const result = await f.run(['install-hooks', '--shell', 'powershell'])
  assert.equal(JSON.parse(result.stdout).status, 'needs-repair')
  assert.equal(await readFile(hooksPath, 'utf8'), bytes)
})

test('malformed hooks and legacy locks fail without changing or deleting unknown files', async (t) => {
  const f = await fixture(t),
    hooksPath = join(f.codexHome, 'hooks.json')
  await writeFile(hooksPath, 'malformed:' + PRIVATE)
  const failed = await f.run(['install-hooks', '--shell', 'git-bash'])
  assert.equal(failed.code, 1)
  assert.equal(failed.stderr.includes(PRIVATE), false)
  assert.equal(await readFile(hooksPath, 'utf8'), 'malformed:' + PRIVATE)
  await writeFile(hooksPath, '{}\n')
  for (const contents of ['', 'other owner']) {
    await writeFile(join(f.root, 'hooks-install.lock'), contents)
    for (const command of [['install-hooks', '--shell', 'git-bash'], ['remove-hooks']]) {
      const result = await f.run(command)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /\[legacy-hook-lock-present\]/)
      assert.equal(await readFile(hooksPath, 'utf8'), '{}\n')
      assert.equal(await readFile(join(f.root, 'hooks-install.lock'), 'utf8'), contents)
    }
  }
})

test('concurrent Hook installations serialize into one owned configuration', async (t) => {
  const f = await fixture(t),
    args = ['install-hooks', '--shell', 'git-bash', '--node', process.execPath]
  const results = await Promise.all([f.run(args), f.run(args)])
  assert.deepEqual(
    results.map((result) => result.code),
    [0, 0],
  )
  assert.deepEqual(results.map((result) => JSON.parse(result.stdout).status).sort(), [
    'installed',
    'unchanged',
  ])
  const hooks = JSON.parse(await readFile(join(f.codexHome, 'hooks.json'), 'utf8'))
  assert.equal(Object.keys(hooks.hooks).length, 7)
  for (const groups of Object.values(hooks.hooks)) {
    assert.equal(groups.length, 1)
    assert.equal(groups[0].hooks.length, 1)
  }
  assert.equal(
    JSON.parse(await readFile(join(f.root, 'hooks-installation.json'), 'utf8')).backups.length,
    1,
  )
  await assert.rejects(readFile(join(f.root, 'hooks-install.lock')), { code: 'ENOENT' })
})

test('Hook installation recovers a transaction ticket after its isolated owner exits', async (t) => {
  const f = await fixture(t),
    storeRoot = join(f.root, 'projects'),
    moduleUrl = new URL('../installer/skill/coordinator/state.mjs', import.meta.url).href,
    script = `const { ProjectStore } = await import(${JSON.stringify(moduleUrl)}); await new ProjectStore({root:${JSON.stringify(storeRoot)}}).transaction('__hook-install__', async () => { process.exit(0) });`
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 10000,
    windowsHide: true,
  })
  const lockPath = new ProjectStore({ root: storeRoot }).paths('__hook-install__').lock
  assert.ok((await readdir(lockPath)).some((file) => file.endsWith('.json')))
  assert.equal((await f.run(['install-hooks', '--shell', 'git-bash'])).code, 0)
  assert.deepEqual(await readdir(lockPath), [])
  assert.equal((await f.run(['remove-hooks'])).code, 0)
  assert.deepEqual(await readdir(lockPath), [])
})

test('removing an untouched generated Hook file restores its original absence', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.run(['install-hooks', '--shell', 'git-bash'])).code, 0)
  assert.equal((await f.run(['remove-hooks'])).code, 0)
  await assert.rejects(readFile(join(f.codexHome, 'hooks.json')), { code: 'ENOENT' })
  assert.ok((await readdir(f.root)).some((file) => file.startsWith('hooks-removed-')))
})

test('default root follows the explicit CODEX_HOME and import never starts a runtime', async (t) => {
  const f = await fixture(t)
  let observed
  class Runtime {
    constructor(options) {
      observed = options
    }
    async status() {
      return { status: 'ok' }
    }
  }
  const code = await main(['status'], {
    Coordinator: Runtime,
    env: { CODEX_HOME: f.codexHome },
    stdout: { write() {} },
    stderr: { write() {} },
  })
  assert.equal(code, 0)
  assert.equal(observed.root, join(f.codexHome, 'opl-dsh-coordinator'))
  assert.equal(observed.codexHome, f.codexHome)
})

test('inspect returns registered acceptance and checkpoints as untrusted data while omitting runtime internals', async (t) => {
  const f = await fixture(t)
  class InspectRuntime extends f.Runtime {
    constructor(options) {
      super(options)
      this.store.get = async () => ({
        ...f.plan,
        mode: 'active',
        authorityEpoch: 2,
        workItems: [{ ...f.plan.workItems[0], evidence: 'registered-evidence' }],
        reviews: [
          {
            reviewRunId: 'review-1',
            result: 'accepted',
            actions: ['reserved', 'accepted', 'uncertain'].map((status, index) => ({
              actionId: `action-${index}`,
              kind: index === 1 ? 'consume' : 'review',
              status,
              reviewRunId: 'review-1',
              consumerId: 'exact-consumer',
              claimEpoch: 2,
              authorityEpoch: 2,
              taskId: 'task-1',
              operationId: 'operation-1',
              createdAt: 100,
              updatedAt: 101,
              evidence: 'never-output-action-evidence',
              error: 'never-output-raw-error',
              credentials: 'never-output-credentials',
            })),
            checkpoint: {
              artifactRevision: 'commit-a',
              checks: [{ id: 'test-a', result: 'passed', evidence: 'check-evidence' }],
            },
          },
        ],
        runtime: {
          status: 'idle',
          binding: { token: 'never-output-runtime-binding' },
          cursor: { identity: 'never-output-runtime-cursor' },
          env: 'never-output-runtime-env',
        },
        intents: [],
        feedback: [],
        control: 'never-output-real-control',
      })
    }
  }
  const result = await f.run(['inspect', '--project', 'exact-project'], {
    Coordinator: InspectRuntime,
  })
  assert.equal(result.code, 0)
  const shown = JSON.parse(result.stdout)
  assert.equal(shown.workItems[0].acceptance, PRIVATE)
  assert.equal(shown.workItems[0].evidence, 'registered-evidence')
  assert.equal(shown.reviews[0].checkpoint.checks[0].evidence, 'check-evidence')
  assert.equal(shown.reviews[0].result, 'accepted')
  assert.deepEqual(
    shown.reviews[0].actions.map((action) => action.status),
    ['reserved', 'accepted', 'uncertain'],
  )
  assert.deepEqual(shown.reviews[0].actions[1], {
    actionId: 'action-1',
    kind: 'consume',
    status: 'accepted',
    reviewRunId: 'review-1',
    consumerId: 'exact-consumer',
    claimEpoch: 2,
    authorityEpoch: 2,
    taskId: 'task-1',
    operationId: 'operation-1',
    createdAt: 100,
    updatedAt: 101,
  })
  assert.match(shown.evidenceTrust, /untrusted/)
  assert.equal(result.stdout.includes('never-output'), false)
  assert.equal(shown.authorization, undefined)
})

test('init discovers only the installed public home storage directory and reports missing sources', async (t) => {
  const f = await fixture(t),
    home = join(f.base, 'installed dsh'),
    config = join(f.base, 'config.json')
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(
    join(home, 'storages/task_feedback.json'),
    'must-not-read-feedback-content:' + PRIVATE,
  )
  await writeFile(config, JSON.stringify({ home, token: PRIVATE, arbitrary: PRIVATE }))
  const result = await f.run(['init', '--file', f.planFile], { skillConfigPath: config })
  assert.equal(JSON.parse(result.stdout).watchStatus, 'metadata-source-configured')
  const saved = JSON.parse(await readFile(join(f.root, 'settings.json'), 'utf8'))
  assert.deepEqual(saved.feedbackWatchPaths, [join(home, 'storages')])
  assert.equal(JSON.stringify(saved).includes(PRIVATE), false)
  const missing = await fixture(t)
  const absent = await missing.run(['init', '--file', missing.planFile], {
    skillConfigPath: join(missing.base, 'absent.json'),
  })
  assert.equal(JSON.parse(absent.stdout).watchStatus, 'no-feedback-metadata-source')
})

test('automatic watch launch reserves one global instance with explicit argv and never repeats a live PID', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.run(['init', '--file', f.planFile])).code, 0)
  assert.equal(f.launchCalls.length, 1)
  const launched = f.launchCalls[0]
  assert.equal(launched.command, process.execPath)
  assert.equal(launched.args[3], '__all__')
  assert.ok(launched.args.includes('--root'))
  assert.ok(launched.args.includes(f.codexHome))
  const saved = JSON.parse(await readFile(join(f.root, 'watcher.json'), 'utf8'))
  assert.equal(saved.pid, 123456)
  assert.equal(saved.projectId, '__all__')
  assert.equal((await f.run(['start-watch', '--project', 'exact-project'])).code, 0)
  assert.equal(f.launchCalls.length, 1)
  await writeFile(
    join(f.root, 'watcher-ready.json'),
    JSON.stringify({ token: saved.token, pid: saved.pid }),
  )
  assert.equal(
    JSON.parse((await f.run(['start-watch', '--project', 'exact-project'])).stdout).status,
    'running',
  )
  assert.equal(f.launchCalls.length, 1)
  assert.equal(
    (await f.run(['start-watch', '--project', 'exact-project'], { probe: async () => 'exited' }))
      .code,
    0,
  )
  assert.equal(f.launchCalls.length, 2)
})

test('unconfirmed launch is durable and manual mode prevents automatic startup', async (t) => {
  const f = await fixture(t)
  await writeFile(f.planFile, JSON.stringify({ ...f.plan, connection: { watchMode: 'manual' } }))
  assert.equal(
    JSON.parse((await f.run(['init', '--file', f.planFile])).stdout).watcher.status,
    'manual',
  )
  assert.equal(f.launchCalls.length, 0)
  let attempts = 0
  const unknown = await f.run(['start-watch', '--project', 'exact-project'], {
    launch: async () => {
      attempts++
      return { pid: null, refusal: PRIVATE }
    },
  })
  assert.equal(JSON.parse(unknown.stdout).status, 'uncertain')
  assert.equal(unknown.stdout.includes(PRIVATE), false)
  assert.equal((await f.run(['start-watch', '--project', 'exact-project'])).code, 0)
  assert.equal(f.launchCalls.length, 0)
  assert.equal(attempts, 1)
})

test('only exact registered Hook targets ensure the watcher', async (t) => {
  const f = await fixture(t)
  class Registered extends f.Runtime {
    async status() {
      return [{ ...f.plan, mode: 'active' }]
    }
  }
  const input = (session_id) =>
    Readable.from([
      JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id,
        cwd: f.base,
        source: 'startup',
      }),
    ])
  assert.equal(
    (await f.run(['hook'], { Coordinator: Registered, stdin: input('foreign-thread') })).code,
    0,
  )
  assert.equal(f.launchCalls.length, 0)
  assert.equal(
    (await f.run(['hook'], { Coordinator: Registered, stdin: input('exact-thread') })).code,
    0,
  )
  assert.equal(f.launchCalls.length, 1)
})

test('stop files abort only the token-matched global watcher and persist manual mode', async (t) => {
  const f = await fixture(t)
  await f.run(['init', '--file', f.planFile])
  const filename = join(f.root, 'watcher.json'),
    record = JSON.parse(await readFile(filename, 'utf8'))
  record.pid = process.pid
  await writeFile(filename, JSON.stringify(record))
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  class Waiting extends f.Runtime {
    async watch(options) {
      assert.equal(options.projectId, undefined)
      started()
      return new Promise((resolve) =>
        options.signal.addEventListener('abort', () => resolve({ status: 'stopped' }), {
          once: true,
        }),
      )
    }
  }
  const running = f.run(['watch', '--project', '__all__', '--watch-token', record.token], {
    Coordinator: Waiting,
  })
  await ready
  try {
    const stopped = await f.run(['stop-watch', '--project', 'exact-project'])
    assert.equal(stopped.code, 0)
    assert.equal(JSON.parse(stopped.stdout).status, 'stopping')
  } finally {
    await writeFile(
      join(f.root, `watch-stop-${record.token}.json`),
      JSON.stringify({ token: record.token }),
    )
    assert.equal((await running).code, 0)
  }
  assert.equal(
    JSON.parse(await readFile(join(f.root, 'settings.json'), 'utf8')).watchMode,
    'manual',
  )
  const exited = JSON.parse(await readFile(join(f.root, 'watcher-exit.json'), 'utf8'))
  assert.equal(exited.pid, process.pid)
  assert.equal(exited.token, record.token)
})

test('the shipped entrypoint registers, reads, pauses and resumes an isolated project across processes', async (t) => {
  const f = await fixture(t)
  await writeFile(f.planFile, JSON.stringify({ ...f.plan, connection: { watchMode: 'manual' } }))
  const filename = fileURLToPath(new URL('../installer/skill/coordinator/cli.mjs', import.meta.url))
  const run = async (args) => {
    const result = await execFileAsync(
      process.execPath,
      [filename, ...args, '--root', f.root, '--codex-home', f.codexHome],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, CODEX_HOME: f.codexHome } },
    )
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.includes(PRIVATE), false)
    return JSON.parse(result.stdout)
  }
  assert.equal((await run(['init', '--file', f.planFile])).projectId, 'exact-project')
  const initial = await run(['status', '--project', 'exact-project'])
  assert.equal(initial.mode, 'active')
  assert.equal(initial.authorityEpoch, 1)
  assert.equal((await run(['pause', '--project', 'exact-project'])).mode, 'paused_by_user')
  const resumed = await run(['resume', '--project', 'exact-project'])
  assert.equal(resumed.mode, 'active')
  assert.equal(resumed.authorityEpoch, 3)
  assert.equal((await run(['status'])).length, 1)
})

test('an isolated real independent watcher acknowledges startup and exits after its stop file', async (t) => {
  const f = await fixture(t)
  const filename = fileURLToPath(new URL('../installer/skill/coordinator/cli.mjs', import.meta.url))
  const helper = join(f.base, 'synthetic-feedback.mjs')
  const homeFile = join(f.root, 'helper-home.json')
  await writeFile(
    helper,
    [
      "import {writeFile,rename} from 'node:fs/promises'",
      "if(process.argv[2]==='tasks'){",
      `await writeFile(${JSON.stringify(homeFile + '.tmp')},JSON.stringify({home:process.env.CODEX_HOME}))`,
      `await rename(${JSON.stringify(homeFile + '.tmp')},${JSON.stringify(homeFile)})`,
      '}',
      "console.log('[]')",
    ].join('\n') + '\n',
  )
  await writeFile(
    f.planFile,
    JSON.stringify({
      ...f.plan,
      workItems: f.plan.workItems.map((work) => ({
        ...work,
        taskId: 'synthetic-task',
        operationId: 'initial',
      })),
      connection: { watchMode: 'manual', controlPath: helper, feedbackWatchPaths: [] },
    }),
  )
  const run = async (args) => {
    const result = await execFileAsync(
      process.execPath,
      [filename, ...args, '--root', f.root, '--codex-home', f.codexHome],
      { encoding: 'utf8', timeout: 70000, env: { ...process.env, CODEX_HOME: f.codexHome } },
    )
    assert.equal(result.stderr, '')
    return JSON.parse(result.stdout)
  }
  let record
  try {
    await run(['init', '--file', f.planFile])
    const started = await run(['start-watch', '--project', 'exact-project'])
    assert.equal(started.status, 'starting')
    record = JSON.parse(await readFile(join(f.root, 'watcher.json'), 'utf8'))
    const ready = await waitJson(
      f.root,
      'watcher-ready.json',
      (value) => value.token === record.token,
    )
    assert.equal(ready.pid, started.pid)
    const helperHome = await waitJson(
      f.root,
      'helper-home.json',
      (value) => value.home === f.codexHome,
    )
    assert.equal(helperHome.home, f.codexHome)
    assert.equal((await run(['start-watch', '--project', 'exact-project'])).status, 'running')
    assert.equal(
      JSON.parse(await readFile(join(f.root, 'watcher.json'), 'utf8')).token,
      record.token,
    )
  } finally {
    await run(['stop-watch', '--project', 'exact-project'])
    if (record) await waitJson(f.root, 'watcher-exit.json', (value) => value.token === record.token)
  }
})

test('setup reports missing Node without installing Hooks or accepting Electron as Node', async (t) => {
  const f = await fixture(t)
  const result = await f.run(['setup'], { nodeProbe: async () => null })
  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'unavailable',
    reason: 'node-runtime-required',
    requiresTrust: false,
    next: 'install-node-and-run-setup',
  })
  await assert.rejects(readFile(join(f.codexHome, 'hooks.json')), { code: 'ENOENT' })
  let calls = 0
  assert.equal(
    await resolveNodeRuntime({
      explicitPath: join(f.base, 'DeepSeek Harness.exe'),
      probe: async () => {
        calls++
        return { path: process.execPath, electron: false }
      },
    }),
    null,
  )
  assert.equal(calls, 0)
  assert.equal(
    await resolveNodeRuntime({
      nodePath: process.execPath,
      probe: async () => ({ path: process.execPath, electron: true }),
    }),
    null,
  )
  assert.equal(
    await resolveNodeRuntime({
      probe: async (candidate) => {
        assert.equal(candidate, 'node')
        return { path: process.execPath, electron: false }
      },
    }),
    process.execPath,
  )
})

test('guided setup preserves malformed user Hooks and returns failure instead of a runtime guide', async (t) => {
  const f = await fixture(t)
  const filename = join(f.codexHome, 'hooks.json')
  await writeFile(filename, '{user-modified')
  assert.equal((await f.run(['setup'])).code, 1)
  assert.equal(await readFile(filename, 'utf8'), '{user-modified')
})

test('legacy local queue settings never override current DSH settings', async (t) => {
  const f = await fixture(t)
  await f.run(['init', '--file', f.planFile])
  const filename = join(f.root, 'settings.json')
  const settings = JSON.parse(await readFile(filename, 'utf8'))
  settings.queue = { transport: 'codex-queue', executable: join(f.base, 'stale-codex.exe') }
  await writeFile(filename, JSON.stringify(settings))
  f.calls.length = 0
  assert.equal((await f.run(['status'])).code, 0)
  assert.equal(Object.hasOwn(f.calls[0][1], 'queue'), false)
  assert.equal((await f.run(['setup'])).code, 0)
  assert.equal(Object.hasOwn(JSON.parse(await readFile(filename, 'utf8')), 'queue'), false)
})
