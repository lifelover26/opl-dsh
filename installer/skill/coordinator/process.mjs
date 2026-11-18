/** Read-only Windows backend identity; process age and leases never establish an exit. */
import { execFile, spawn as spawnProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { supportsBackendVersion } from './hooks.mjs'

const MAX_ANCESTORS = 8
const QUERY_BYTES = 32 * 1024
const CAPTURE_TIMEOUT = 1800
const INSPECT_TIMEOUT = 1500
const WAIT_START_TIMEOUT = 2500
const WAIT_OUTPUT_BYTES = 4096
const activeWaiters = new Set()
const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const unknown = (reason) => ({ status: 'unknown', reason })

/** Execute fixed argv with no shell, bounded output, and no diagnostic text returned on failure. */
function defaultRun(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error('process-command-failed'))
      else resolve({ stdout, code: 0 })
    })
  })
}

function executablePath(value) {
  if (typeof value !== 'string' || value.length > 32768 || /[\0\r\n]/.test(value)) return null
  let normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('//?/')) normalized = normalized.slice(4)
  if (!/^[A-Za-z]:\//.test(normalized) || normalized.slice(2).includes(':')) return null
  normalized = path.win32.normalize(normalized).replaceAll('\\', '/')
  if (path.win32.basename(normalized).toLowerCase() !== 'codex.exe') return null
  return normalized
}

function birth(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value))
    return null
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    return null
  return value
}

function processRow(value) {
  if (
    !isObject(value) ||
    !validPid(value.pid) ||
    !Number.isSafeInteger(value.parentPid) ||
    value.parentPid < 0 ||
    value.parentPid > 0xffffffff ||
    !birth(value.processBirth)
  )
    return null
  if (
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 260 ||
    /[\0\r\n]/.test(value.name)
  )
    return null
  if (
    value.executable !== null &&
    (typeof value.executable !== 'string' ||
      value.executable.length > 32768 ||
      /[\0\r\n]/.test(value.executable))
  )
    return null
  return {
    pid: value.pid,
    parentPid: value.parentPid,
    processBirth: value.processBirth,
    executable: value.executable,
    name: value.name,
  }
}

// -NoProfile prevents loading user shell startup code. The projection excludes arguments/env.
function queryScript(pid, ancestors) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$rows = @()',
    `$nextProcessId = ${pid}`,
    `$maximum = ${ancestors ? MAX_ANCESTORS : 1}`,
    'for ($index = 0; $index -lt $maximum -and $nextProcessId -gt 0; $index++) {',
    '  $entry = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $nextProcessId" -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,Name -ErrorAction Stop',
    '  if ($null -eq $entry) { break }',
    '  $rows += [pscustomobject]@{',
    '    pid = [long]$entry.ProcessId',
    '    parentPid = [long]$entry.ParentProcessId',
    "    processBirth = $entry.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')",
    '    executable = $entry.ExecutablePath',
    '    name = $entry.Name',
    '  }',
    "  if ($entry.Name -ieq 'codex.exe') { break }",
    '  $nextProcessId = [long]$entry.ParentProcessId',
    '}',
    'ConvertTo-Json -InputObject @($rows) -Compress -Depth 3',
  ].join('\n')
}

async function command(run, file, args, timeout, maxBuffer) {
  if (timeout <= 0) return null
  try {
    const result = await run(file, args, { timeout, maxBuffer, windowsHide: true })
    if (
      !isObject(result) ||
      (result.code != null && result.code !== 0) ||
      (result.exitCode != null && result.exitCode !== 0) ||
      result.signal != null
    )
      return null
    if (!(typeof result.stdout === 'string' || Buffer.isBuffer(result.stdout))) return null
    if (Buffer.byteLength(result.stdout) > maxBuffer) return null
    return result.stdout
      .toString()
      .replace(/^\uFEFF/, '')
      .trim()
  } catch {
    return null
  }
}

async function query(run, pid, ancestors, timeout) {
  const stdout = await command(
    run,
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', queryScript(pid, ancestors)],
    timeout,
    QUERY_BYTES,
  )
  if (stdout === null) return { status: 'unknown', reason: 'process-query-failed' }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return unknown('invalid-process-metadata')
  }
  if (!Array.isArray(parsed) || parsed.length > (ancestors ? MAX_ANCESTORS : 1))
    return unknown('invalid-process-metadata')
  const rows = parsed.map(processRow)
  if (rows.some((row) => row === null)) return unknown('invalid-process-metadata')
  return { status: 'known', rows }
}

/**
 * Identify one of at most eight ancestors using PID, creation time and exact executable version.
 * Inject run(file,args,options) for isolated tests. Its result is {stdout,code?/exitCode?,signal?}.
 * No match, access denial, ancestry races or an unsupported backend return unknown.
 */
export async function findBackendProcess({
  startPid = process.ppid,
  run = defaultRun,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return unknown('unsupported-platform')
  if (!validPid(startPid) || typeof run !== 'function') return unknown('invalid-process-identity')
  const deadline = performance.now() + CAPTURE_TIMEOUT
  const result = await query(run, startPid, true, CAPTURE_TIMEOUT)
  if (result.status !== 'known') return result
  const seen = new Set()
  let expectedPid = startPid,
    childBirth = null
  for (const row of result.rows) {
    if (row.pid !== expectedPid || seen.has(row.pid)) return unknown('invalid-ancestor-chain')
    if (childBirth !== null && row.processBirth > childBirth) return unknown('ancestor-pid-reused')
    seen.add(row.pid)
    if (row.name.toLowerCase() === 'codex.exe') {
      const executable = executablePath(row.executable)
      if (!executable) return unknown('backend-path-unavailable')
      const version = await command(
        run,
        executable,
        ['--version'],
        Math.max(0, Math.floor(deadline - performance.now())),
        1024,
      )
      if (version === null) return unknown('backend-version-unavailable')
      const backendVersion = version.startsWith('codex-cli ') ? version.slice(10) : null
      if (!supportsBackendVersion(backendVersion)) return unknown('unsupported-backend-version')
      const fingerprint = JSON.stringify([row.pid, row.processBirth, executable.toLowerCase()])
      return {
        status: 'known',
        pid: row.pid,
        processBirth: row.processBirth,
        executable,
        backendVersion,
        runId: `codex:${createHash('sha256').update(fingerprint).digest('hex')}`,
      }
    }
    expectedPid = row.parentPid
    childBirth = row.processBirth
  }
  return unknown(result.rows.length === MAX_ANCESTORS ? 'ancestor-limit' : 'backend-not-found')
}

/** Alias used by hook entrypoints to capture their owning backend instance. */
export const captureHookOwner = findBackendProcess

/**
 * Inspect the saved PID and creation time. A missing PID or changed birth proves that saved
 * instance exited; access/query errors remain unknown. This does not grant replacement authority.
 */
export async function inspectProcess({
  pid,
  processBirth,
  executable = null,
  run = defaultRun,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return unknown('unsupported-platform')
  if (
    !validPid(pid) ||
    !birth(processBirth) ||
    typeof run !== 'function' ||
    (executable !== null && !executablePath(executable))
  )
    return unknown('invalid-process-identity')
  const result = await query(run, pid, false, INSPECT_TIMEOUT)
  if (result.status !== 'known') return result
  if (result.rows.length === 0) return { status: 'exited', reason: 'process-missing' }
  const row = result.rows[0]
  if (row.pid !== pid) return unknown('invalid-process-metadata')
  if (row.processBirth !== processBirth) return { status: 'exited', reason: 'pid-reused' }
  if (
    row.name.toLowerCase() !== 'codex.exe' ||
    (executable !== null &&
      executablePath(row.executable)?.toLowerCase() !== executablePath(executable).toLowerCase())
  )
    return unknown('process-identity-mismatch')
  return { status: 'alive' }
}

function waitScript(pid, processBirth) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$ownedProcess = $null',
    'try {',
    `  $ownedProcess = [System.Diagnostics.Process]::GetProcessById(${pid})`,
    // A retained handle pins the process instance before the birth query and wait attach.
    '  $null = $ownedProcess.Handle',
    `  $entry = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}" -Property CreationDate -ErrorAction Stop`,
    `  if ($null -ne $entry -and $entry.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ') -eq '${processBirth}') {`,
    "    [Console]::WriteLine('waiting')",
    '    Wait-Process -InputObject $ownedProcess -ErrorAction Stop',
    '  }',
    "  [Console]::WriteLine('finished')",
    '} catch {',
    "  [Console]::WriteLine('unavailable')",
    '  exit 1',
    '} finally {',
    '  if ($null -ne $ownedProcess) { $ownedProcess.Dispose() }',
    '}',
  ].join('\n')
}

function waitWithHelper({ pid, processBirth, signal, spawn }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', waitScript(pid, processBirth)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
      )
    } catch {
      resolve('wait-helper-failed')
      return
    }
    let failure = null,
      outputBytes = 0,
      pending = '',
      waiting = false,
      terminating = false
    const stop = (reason) => {
      failure ??= reason
      // child is solely the helper returned by spawn; the backend PID is never signalled.
      if (terminating) return
      terminating = true
      try {
        child.kill()
      } catch (error) {
        /* A helper already closing still emits close. */
      }
    }
    const abort = () => stop('wait-aborted')
    const startup = setTimeout(() => stop('wait-helper-timeout'), WAIT_START_TIMEOUT)
    child.stdout?.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > WAIT_OUTPUT_BYTES) {
        stop('wait-output-too-large')
        return
      }
      pending += chunk.toString()
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const marker = pending.slice(0, end).replace(/\r$/, '')
        pending = pending.slice(end + 1)
        if (marker === 'waiting' && !waiting) {
          waiting = true
          clearTimeout(startup)
        } else if (marker !== 'finished' && marker !== 'unavailable') stop('invalid-wait-output')
      }
    })
    child.stderr?.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > WAIT_OUTPUT_BYTES) stop('wait-output-too-large')
    })
    child.once('error', () => {
      failure ??= 'wait-helper-failed'
    })
    child.once('close', (code, exitSignal) => {
      clearTimeout(startup)
      signal?.removeEventListener('abort', abort)
      if (pending.length) failure ??= 'invalid-wait-output'
      if (code !== 0 || exitSignal !== null) failure ??= 'wait-helper-failed'
      resolve(failure)
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/**
 * Wait for one saved Windows process instance without polling. Only one waiter per PID/birth
 * may run in this module instance. Abort stops and awaits the owned PowerShell helper only.
 * The helper pins a process handle before checking CIM birth and waiting; post-inspection,
 * rather than helper exit, establishes that the saved backend exited. Unknown grants no takeover.
 */
export async function waitBackendExit({
  pid,
  processBirth,
  executable = null,
  signal,
  run = defaultRun,
  spawn = spawnProcess,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return unknown('unsupported-platform')
  if (
    !validPid(pid) ||
    !birth(processBirth) ||
    typeof run !== 'function' ||
    typeof spawn !== 'function' ||
    (executable !== null && !executablePath(executable))
  )
    return unknown('invalid-process-identity')
  if (
    signal != null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    return unknown('invalid-wait-signal')
  if (signal?.aborted) return unknown('wait-aborted')
  const key = `${pid}:${processBirth}`
  if (activeWaiters.has(key)) return unknown('waiter-already-active')
  activeWaiters.add(key)
  try {
    const identity = { pid, processBirth, executable, run, platform }
    const before = await inspectProcess(identity)
    if (before.status !== 'alive') return before
    if (signal?.aborted) return unknown('wait-aborted')
    const failure = await waitWithHelper({ pid, processBirth, signal, spawn })
    if (signal?.aborted || failure === 'wait-aborted') return unknown('wait-aborted')
    const after = await inspectProcess(identity)
    if (signal?.aborted) return unknown('wait-aborted')
    if (after.status === 'exited' || after.status === 'unknown') return after
    return unknown(failure ?? 'process-exit-unconfirmed')
  } finally {
    activeWaiters.delete(key)
  }
}
