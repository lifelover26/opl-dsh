/** Process identity tests inject metadata; they never enumerate or terminate real processes. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  captureHookOwner,
  findBackendProcess,
  inspectProcess,
  waitBackendExit,
} from '../installer/skill/coordinator/process.mjs'

const PRIVATE = 'SYNTHETIC-PRIVATE-CONTENT-NOT-FOR-DIAGNOSTICS'
const BIRTH = '2026-11-15T01:02:03.1234567Z'
const CHILD_BIRTH = '2026-11-15T01:02:04.1234567Z'
const executable = 'C:/Program Files/Codex/codex.exe'
const row = (extra = {}) => ({
  pid: 41,
  parentPid: 10,
  processBirth: BIRTH,
  name: 'codex.exe',
  executable,
  ...extra,
})

function runner(rows = [row()], version = 'codex-cli 0.167.0') {
  const calls = []
  const run = async (file, args, options) => {
    calls.push({ file, args, options })
    if (file === 'powershell.exe') return { stdout: JSON.stringify(rows), code: 0 }
    return { stdout: `${version}\n`, code: 0 }
  }
  return { run, calls }
}

const find = (run, extra = {}) =>
  findBackendProcess({ startPid: 41, platform: 'win32', run, ...extra })
const inspect = (run, extra = {}) =>
  inspectProcess({ pid: 41, processBirth: BIRTH, executable, platform: 'win32', run, ...extra })

test('capture verifies exact codex executable version and produces a stable instance identity', async () => {
  const first = runner()
  const result = await find(first.run)
  assert.equal(result.status, 'known')
  assert.equal(result.pid, 41)
  assert.equal(result.processBirth, BIRTH)
  assert.equal(result.executable, executable)
  assert.equal(result.backendVersion, '0.167.0')
  assert.match(result.runId, /^codex:[a-f0-9]{64}$/)
  assert.deepEqual(first.calls[1].args, ['--version'])
  assert.equal(first.calls[1].file, executable)
  const again = await find(runner().run)
  assert.equal(again.runId, result.runId)
  assert.notEqual(
    (await find(runner([row({ processBirth: CHILD_BIRTH })]).run)).runId,
    result.runId,
  )
  assert.notEqual(
    (await find(runner([row({ pid: 42 })]).run, { startPid: 42 })).runId,
    result.runId,
  )
  assert.equal(captureHookOwner, findBackendProcess)
})

test('capture attests the verified 0.169.0 backend without relabeling its version', async () => {
  const result = await find(runner([row()], 'codex-cli 0.169.0').run)
  assert.equal(result.status, 'known')
  assert.equal(result.backendVersion, '0.169.0')
  assert.equal(result.runId, (await find(runner().run)).runId)
})

test('ancestry follows exact parent links and accepts the backend only within eight nodes', async () => {
  const rows = Array.from({ length: 7 }, (_, index) =>
    row({
      pid: 100 - index,
      parentPid: 99 - index,
      name: 'shell.exe',
      executable: null,
      processBirth: CHILD_BIRTH,
    }),
  )
  rows.push(row({ pid: 93 }))
  assert.equal((await find(runner(rows).run, { startPid: 100 })).status, 'known')
  const limit = await find(runner(rows.map((item) => ({ ...item, name: 'shell.exe' }))).run, {
    startPid: 100,
  })
  assert.equal(limit.reason, 'ancestor-limit')
  assert.equal(
    (await find(runner([...rows, row()]).run, { startPid: 100 })).reason,
    'invalid-process-metadata',
  )
})

test('mismatched links, repeated PIDs and reused ancestor PIDs remain unknown', async () => {
  const child = row({
    pid: 50,
    parentPid: 41,
    processBirth: CHILD_BIRTH,
    name: 'bash.exe',
    executable: null,
  })
  assert.equal((await find(runner([child, row()]).run, { startPid: 50 })).status, 'known')
  assert.equal(
    (await find(runner([child, row({ pid: 40 })]).run, { startPid: 50 })).reason,
    'invalid-ancestor-chain',
  )
  assert.equal(
    (await find(runner([{ ...child, parentPid: 50 }, child]).run, { startPid: 50 })).reason,
    'invalid-ancestor-chain',
  )
  assert.equal(
    (
      await find(runner([child, row({ processBirth: '2026-11-15T01:02:05.1234567Z' })]).run, {
        startPid: 50,
      })
    ).reason,
    'ancestor-pid-reused',
  )
})

test('query selects metadata only, does not load shell profiles and enforces output/time limits', async () => {
  const { run, calls } = runner()
  await find(run)
  assert.equal(calls[0].file, 'powershell.exe')
  assert.ok(calls[0].args.includes('-NoProfile'))
  assert.ok(calls[0].args.includes('-NonInteractive'))
  const script = calls[0].args.at(-1)
  assert.match(script, /Get-CimInstance -ClassName Win32_Process/)
  assert.match(script, /-Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,Name/)
  assert.doesNotMatch(script, /CommandLine|\$env:|Get-ChildItem|Invoke-Expression|Start-Process/)
  assert.match(script, /\$maximum = 8/)
  for (const call of calls) {
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 1800)
    assert.ok(call.options.maxBuffer > 0 && call.options.maxBuffer <= 32768)
    assert.equal(call.options.windowsHide, true)
    assert.equal(call.options.shell, undefined)
  }
})

test('unsupported platforms and invalid PID inputs do not invoke commands', async () => {
  const { run, calls } = runner()
  assert.equal((await find(run, { platform: 'linux' })).reason, 'unsupported-platform')
  for (const startPid of [0, -1, 1.5, '41', NaN, 0x100000000])
    assert.equal((await find(run, { startPid })).reason, 'invalid-process-identity')
  assert.equal(calls.length, 0)
})

test('missing ancestors, access denial and invalid metadata do not become exited evidence', async () => {
  assert.equal((await find(runner([]).run)).reason, 'backend-not-found')
  assert.equal(
    (
      await find(async () => {
        throw new Error(PRIVATE)
      })
    ).reason,
    'process-query-failed',
  )
  for (const stdout of [
    'not JSON',
    '{}',
    'null',
    JSON.stringify([{ ...row(), processBirth: null }]),
    JSON.stringify([{ ...row(), pid: '41' }]),
    JSON.stringify([{ ...row(), parentPid: -1 }]),
    JSON.stringify([{ ...row(), processBirth: '2026-02-30T01:02:03.1234567Z' }]),
  ]) {
    const result = await find(async () => ({ stdout }))
    assert.equal(result.reason, 'invalid-process-metadata')
    assert.ok(!JSON.stringify(result).includes(PRIVATE))
  }
})

test('nonzero exit, signal and oversized query output fail closed without diagnostic contents', async () => {
  for (const response of [
    { stdout: PRIVATE, code: 1 },
    { stdout: PRIVATE, exitCode: 2 },
    { stdout: PRIVATE, signal: 'SIGTERM' },
    { stdout: 'x'.repeat(32769) },
    { stdout: null },
  ]) {
    const result = await find(async () => response)
    assert.equal(result.reason, 'process-query-failed')
    assert.ok(!JSON.stringify(result).includes(PRIVATE))
  }
})

test('executable names, local absolute paths and supported version are mandatory', async () => {
  for (const path of [
    null,
    'codex.exe',
    'C:/Program Files/Codex/other.exe',
    '//server/share/codex.exe',
    'C:/path/codex.exe:stream',
    'C:/bad\n/codex.exe',
  ]) {
    const r = runner([row({ executable: path })])
    const result = await find(r.run)
    assert.equal(result.status, 'unknown')
    assert.ok(['backend-path-unavailable', 'invalid-process-metadata'].includes(result.reason))
    assert.equal(r.calls.length, 1)
  }
  for (const version of [
    'codex-cli 0.168.0',
    'codex-cli 0.170.0',
    'codex-cli 0.169.0-beta',
    'codex-cli 0.169.1',
    'codex-cli 0.167.0-beta',
    `codex-cli 0.167.0\n${PRIVATE}`,
    PRIVATE,
  ]) {
    const result = await find(runner([row()], version).run)
    assert.equal(result.reason, 'unsupported-backend-version')
    assert.ok(!JSON.stringify(result).includes(PRIVATE))
  }
})

test('version command failure or oversize is unknown and never returns version stderr', async () => {
  for (const versionResult of [{ stdout: PRIVATE, code: 1 }, { stdout: 'x'.repeat(1025) }]) {
    const result = await find(async (file) =>
      file === 'powershell.exe' ? { stdout: JSON.stringify([row()]) } : versionResult,
    )
    assert.equal(result.reason, 'backend-version-unavailable')
    assert.ok(!JSON.stringify(result).includes(PRIVATE))
  }
})

test('Windows extended executable aliases resolve to one fingerprint', async () => {
  const alias = await find(
    runner([row({ executable: '\\\\?\\C:\\Program Files\\Codex\\codex.exe' })]).run,
  )
  const normal = await find(runner().run)
  assert.equal(alias.status, 'known')
  assert.equal(alias.executable, executable)
  assert.equal(alias.runId, normal.runId)
})

test('inspect requires same PID and precise process birth for alive', async () => {
  const { run, calls } = runner()
  assert.deepEqual(await inspect(run), { status: 'alive' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].args.at(-1), /\$maximum = 1/)
  assert.deepEqual(await inspect(runner([row({ processBirth: CHILD_BIRTH })]).run), {
    status: 'exited',
    reason: 'pid-reused',
  })
  assert.deepEqual(await inspect(runner([]).run), { status: 'exited', reason: 'process-missing' })
  assert.equal((await inspect(runner([row({ pid: 42 })]).run)).reason, 'invalid-process-metadata')
})

test('inspect cannot use kill0, clock age, inaccessible metadata or wrong executable as exit proof', async () => {
  const denied = await inspect(async () => {
    throw new Error(PRIVATE)
  })
  assert.deepEqual(denied, { status: 'unknown', reason: 'process-query-failed' })
  assert.equal(
    (await inspect(runner([row({ executable: 'D:/other/codex.exe' })]).run)).reason,
    'process-identity-mismatch',
  )
  assert.equal(
    (await inspect(runner([row({ name: 'other.exe' })]).run)).reason,
    'process-identity-mismatch',
  )
  assert.equal(
    (await inspect(runner().run, { processBirth: 'yesterday', lastSeen: 0, leaseExpired: true }))
      .reason,
    'invalid-process-identity',
  )
  assert.equal((await inspect(runner().run, { platform: 'darwin' })).reason, 'unsupported-platform')
  assert.equal(
    (await inspect(runner().run, { executable: 'codex.exe' })).reason,
    'invalid-process-identity',
  )
  assert.equal((await inspect(runner().run, { executable: null })).status, 'alive')
})

test('metadata projection excludes arbitrary extra fields from results', async () => {
  const result = await find(
    runner([row({ CommandLine: PRIVATE, environment: PRIVATE, token: PRIVATE })]).run,
  )
  assert.equal(result.status, 'known')
  assert.ok(!JSON.stringify(result).includes(PRIVATE))
  assert.deepEqual(Object.keys(result).sort(), [
    'backendVersion',
    'executable',
    'pid',
    'processBirth',
    'runId',
    'status',
  ])
})

function fakeWaiter() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kills = 0
  child.kill = () => {
    child.kills++
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
    return true
  }
  return child
}

function waitingFixture() {
  const child = fakeWaiter()
  const calls = []
  let queryCount = 0
  let resolveStarted
  const started = new Promise((resolve) => {
    resolveStarted = resolve
  })
  const run = async () => ({ stdout: JSON.stringify(queryCount++ === 0 ? [row()] : []) })
  const spawn = (file, args, options) => {
    calls.push({ file, args, options })
    queueMicrotask(() => {
      child.stdout.write('waiting\r\n')
      resolveStarted()
    })
    return child
  }
  return { child, calls, started, run, spawn, queryCount: () => queryCount }
}

const wait = (options = {}) =>
  waitBackendExit({ pid: 41, processBirth: BIRTH, executable, platform: 'win32', ...options })

test('waiter uses one pinned process wait and requires post-exit identity evidence', async () => {
  const f = waitingFixture()
  const result = wait(f)
  await f.started
  assert.equal(f.queryCount(), 1)
  assert.equal(f.calls.length, 1)
  const script = f.calls[0].args.at(-1)
  assert.ok(script.indexOf('$ownedProcess.Handle') < script.indexOf('Get-CimInstance'))
  assert.match(script, /Wait-Process -InputObject \$ownedProcess/)
  assert.doesNotMatch(script, /Stop-Process|CommandLine|\$env:|Start-Sleep|while\s*\(/)
  assert.equal(f.calls[0].options.shell, false)
  assert.equal(f.calls[0].options.windowsHide, true)
  f.child.stdout.write('finished\n')
  f.child.emit('close', 0, null)
  assert.deepEqual(await result, { status: 'exited', reason: 'process-missing' })
  assert.equal(f.queryCount(), 2)
  assert.equal(f.child.kills, 0)
})

test('same backend has one waiter and releases ownership after close', async () => {
  const f = waitingFixture()
  const result = wait(f)
  await f.started
  assert.deepEqual(await wait(f), { status: 'unknown', reason: 'waiter-already-active' })
  assert.equal(f.calls.length, 1)
  f.child.emit('close', 0, null)
  await result
  const alreadyExited = await wait({
    run: async () => ({ stdout: '[]' }),
    spawn: () => {
      throw new Error('must not spawn')
    },
  })
  assert.deepEqual(alreadyExited, { status: 'exited', reason: 'process-missing' })
})

test('abort terminates only the owned helper and waits for its close event', async () => {
  const f = waitingFixture()
  const controller = new AbortController()
  let settled = false
  const result = wait({ ...f, signal: controller.signal }).then((value) => {
    settled = true
    return value
  })
  await f.started
  f.child.kill = () => {
    f.child.kills++
    return true
  }
  controller.abort()
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(f.child.kills, 1)
  assert.equal(f.queryCount(), 1)
  f.child.emit('close', null, 'SIGTERM')
  assert.deepEqual(await result, { status: 'unknown', reason: 'wait-aborted' })
  assert.equal(f.queryCount(), 1)
})

test('already aborted or unknown identity never starts a waiter', async () => {
  const f = waitingFixture()
  const signal = AbortSignal.abort()
  assert.deepEqual(await wait({ ...f, signal }), { status: 'unknown', reason: 'wait-aborted' })
  assert.equal(f.queryCount(), 0)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(
    await wait({
      ...f,
      run: async () => {
        throw new Error(PRIVATE)
      },
    }),
    { status: 'unknown', reason: 'process-query-failed' },
  )
  assert.equal(f.calls.length, 0)
  assert.equal((await wait({ ...f, platform: 'linux' })).reason, 'unsupported-platform')
  assert.equal((await wait({ ...f, signal: {} })).reason, 'invalid-wait-signal')
  assert.equal((await wait({ ...f, pid: '../injection' })).reason, 'invalid-process-identity')
})

test('abort during final inspection cannot report an automatic exit event', async () => {
  const f = waitingFixture()
  const controller = new AbortController()
  let releaseInspection,
    inspectionStarted,
    queries = 0
  const inspecting = new Promise((resolve) => {
    inspectionStarted = resolve
  })
  const finalInspection = new Promise((resolve) => {
    releaseInspection = resolve
  })
  const result = wait({
    ...f,
    signal: controller.signal,
    run: async () => {
      if (queries++ === 0) return { stdout: JSON.stringify([row()]) }
      inspectionStarted()
      return finalInspection
    },
  })
  await f.started
  f.child.emit('close', 0, null)
  await inspecting
  controller.abort()
  releaseInspection({ stdout: '[]' })
  assert.deepEqual(await result, { status: 'unknown', reason: 'wait-aborted' })
  assert.equal(f.child.kills, 0)
})

test('helper exit alone cannot prove backend exit or override inaccessible post-inspection', async () => {
  const f = waitingFixture()
  const alive = wait({ ...f, run: runner().run })
  await f.started
  f.child.emit('close', 0, null)
  assert.deepEqual(await alive, { status: 'unknown', reason: 'process-exit-unconfirmed' })
  const denied = waitingFixture()
  let queries = 0
  const result = wait({
    ...denied,
    run: async () => {
      if (queries++ === 0) return { stdout: JSON.stringify([row()]) }
      throw new Error(PRIVATE)
    },
  })
  await denied.started
  denied.child.emit('close', 0, null)
  assert.deepEqual(await result, { status: 'unknown', reason: 'process-query-failed' })
})

test('oversized helper output is discarded and kills only the helper', async () => {
  const f = waitingFixture()
  const result = wait({ ...f, run: runner().run })
  await f.started
  f.child.stdout.write(PRIVATE.repeat(100))
  assert.deepEqual(await result, { status: 'unknown', reason: 'wait-output-too-large' })
  assert.equal(f.child.kills, 1)
})

test('helper startup failure stays unknown if the backend is still alive', async () => {
  const result = await wait({
    run: runner().run,
    spawn: () => {
      throw new Error(PRIVATE)
    },
  })
  assert.deepEqual(result, { status: 'unknown', reason: 'wait-helper-failed' })
  assert.ok(!JSON.stringify(result).includes(PRIVATE))
})
