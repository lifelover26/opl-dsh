/** Apply a prepared update after the official Desktop and its Host have exited. */
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installationPaths } from './installation-paths.mjs'
import { launchIndependent, quoteWindowsArgument } from './windows-lifecycle.mjs'
import { readPreparedUpdate, refreshEnhancements } from './update.mjs'
import {
  acquireSuiteMaintenance,
  readUpdateTransaction,
  updateProcessAlive,
} from './update-transaction.mjs'

const script = fileURLToPath(import.meta.url)
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function pendingDigest(root) {
  const path = join(root, 'enhancement-pending.json')
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw Error('待更新计划不是有效文件')
    return digest(await readFile(path))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function executable(application) {
  return join(
    application,
    process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'Contents/MacOS/DeepSeek Harness',
  )
}

/** List only processes using this official executable; never expose their command lines. */
function desktopProcesses(application) {
  const target = resolve(executable(application))
  let result
  if (process.platform === 'win32') {
    const code = [
      "$ErrorActionPreference = 'Stop'",
      'Get-CimInstance Win32_Process -Filter "Name = \'DeepSeek Harness.exe\'" |',
      '  Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress',
    ].join('\n')
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
    )
    result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    })
    if (result.error || result.status !== 0) throw Error('无法检查桌面进程')
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : []
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter(
        (row) =>
          typeof row.ExecutablePath === 'string' &&
          resolve(row.ExecutablePath).toLowerCase() === target.toLowerCase() &&
          !String(row.CommandLine ?? '').includes('--opl-post-exit-update'),
      )
      .map((row) => row.ProcessId)
  }
  result = spawnSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'command='], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw Error('无法检查桌面进程')
  return result.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/u.exec(line))
    .filter(
      (row) =>
        row &&
        (row[2] === target || row[2].startsWith(target + ' ')) &&
        !row[2].includes('--opl-post-exit-update'),
    )
    .map((row) => Number(row[1]))
}

/** Join the official Desktop's profile-initialization lock without taking over another owner. */
async function profileLock(profileHome) {
  const path = join(await realpath(join(profileHome, 'profiles/desktop')), 'lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle
    try {
      handle = await open(path, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n`)
      await handle.sync()
    } catch (error) {
      await handle?.close().catch(() => {})
      if (handle) await unlink(path).catch(() => {})
      if (error.code !== 'EEXIST') throw error
      const stat = await lstat(path)
      const owner = Number.parseInt((await readFile(path, 'utf8')).trim(), 10)
      if (!Number.isSafeInteger(owner) || owner <= 1 || updateProcessAlive(owner)) return null
      const latest = await lstat(path)
      if (latest.dev !== stat.dev || latest.ino !== stat.ino) continue
      await unlink(path)
      continue
    }
    const own = await handle.stat()
    return async () => {
      await handle.close()
      const current = await lstat(path).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (current && current.dev === own.dev && current.ino === own.ino) await unlink(path)
    }
  }
  return null
}

/** Start an independent, one-shot watcher for this exact prepared plan. */
export async function armPostExitUpdate({
  root,
  application,
  profileHome,
  skillDir,
  hostPid,
  desktopPid,
}) {
  const current = installationPaths(
    JSON.parse(await readFile(join(root, 'installation.json'), 'utf8')),
    {
      suiteRoot: root,
      profileHome,
    },
  )
  if (resolve(current.app) !== resolve(application) || current.release !== dirname(script))
    throw Error('更新进程与当前安装不匹配')
  if (
    !Number.isSafeInteger(hostPid) ||
    hostPid <= 1 ||
    !Number.isSafeInteger(desktopPid) ||
    desktopPid <= 1
  )
    throw Error('无法核验桌面进程')
  if (!desktopProcesses(application).includes(desktopPid)) throw Error('当前 Host 不属于该官方桌面')
  if (!(await readPreparedUpdate(root))) return false
  const expected = await pendingDigest(root)
  if (!expected) return false
  const args = [
    script,
    '--opl-post-exit-update',
    root,
    application,
    profileHome,
    expected,
    String(hostPid),
    String(desktopPid),
  ]
  let wrapper
  let started
  if (process.platform === 'win32') {
    wrapper = join(root, 'updates', `post-exit-${randomUUID()}.vbs`)
    const literal = (value) => '"' + String(value).replaceAll('"', '""') + '"'
    const line = [executable(application), ...args, wrapper].map(quoteWindowsArgument).join(' ')
    const content = [
      'Set shell = CreateObject("WScript.Shell")',
      'shell.CurrentDirectory = ' + literal(root),
      'shell.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"',
      'shell.Environment("Process")("NODE_USE_SYSTEM_CA") = "1"',
      'shell.Environment("Process")("CODEX_HOME") = ' + literal(dirname(dirname(skillDir))),
      'shell.Run ' + literal(line) + ', 0, False',
      '',
    ].join('\r\n')
    await writeFile(wrapper, Buffer.from('\ufeff' + content, 'utf16le'), {
      mode: 0o600,
      flag: 'wx',
    })
    started = launchIndependent({
      command: 'wscript.exe',
      args: [wrapper],
      label: 'post-exit-update',
    })
  } else {
    started = launchIndependent({
      command: executable(application),
      args,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_USE_SYSTEM_CA: '1' },
      label: 'post-exit-update',
    })
  }
  if (
    !started?.pid ||
    started.refusal ||
    (process.platform === 'win32' && started.guarantee !== 'job-independent')
  ) {
    if (wrapper) await unlink(wrapper).catch(() => {})
    throw Error('无法启动退出后的更新进程')
  }
  return true
}

/** Wait for a stopped Desktop and apply only the plan that armed this watcher. */
export async function runPostExitUpdate(
  { root, application, profileHome, expected, hostPid, desktopPid },
  options = {},
) {
  const alive = options.alive ?? updateProcessAlive
  const processes = options.processes ?? desktopProcesses
  const wait = options.wait ?? pause
  const apply = options.apply ?? refreshEnhancements
  // A manual transaction excludes new watcher reservations before its restart.
  const lock =
    options.lock ??
    (async (home) => {
      const access = await acquireSuiteMaintenance(root)
      try {
        return await profileLock(home)
      } finally {
        await access.release()
      }
    })
  let release
  const handedOff = async () => {
    const transaction = await readUpdateTransaction(root)
    return (
      transaction?.targetPendingSha256 === expected &&
      !['failed', 'cancelled', 'succeeded'].includes(transaction.stage) &&
      alive(transaction.ownerPid)
    )
  }

  // Reserve the next official Desktop initialization before waiting for exit.
  // A quick relaunch must not run the old profile between this watcher and the
  // installed update. A crashed watcher leaves only its PID for the official
  // app's normal stale-lock recovery.
  while (!release) {
    if ((await pendingDigest(root)) !== expected) return 'changed'
    if (await handedOff()) return 'handoff'
    try {
      release = await lock(profileHome)
    } catch (error) {
      if (await handedOff()) return 'handoff'
      throw error
    }
    if (!release) await wait(1000)
  }

  try {
    while ((await pendingDigest(root)) === expected) {
      if (await handedOff()) return 'handoff'
      if (alive(hostPid) || alive(desktopPid) || (await processes(application)).length) {
        await wait(1000)
        continue
      }
      if ((await pendingDigest(root)) !== expected) return 'changed'
      // Recheck after pending validation because a launch can finish between
      // process discovery and the installer's own profile checks.
      if (alive(hostPid) || alive(desktopPid) || (await processes(application)).length) continue
      await apply(root, application, {
        expectedPendingSha256: expected,
        trigger: 'post-exit',
      })
      return (await pendingDigest(root)) === null ? 'updated' : 'deferred'
    }
    return 'changed'
  } finally {
    await release()
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === script &&
  process.argv[2] === '--opl-post-exit-update'
) {
  const [root, application, profileHome, expected, host, desktop, wrapper] = process.argv.slice(3)
  if (wrapper) await unlink(wrapper).catch(() => {})
  try {
    const hostPid = Number(host),
      desktopPid = Number(desktop)
    if (
      !/^[a-f0-9]{64}$/u.test(expected) ||
      !Number.isSafeInteger(hostPid) ||
      hostPid <= 1 ||
      !Number.isSafeInteger(desktopPid) ||
      desktopPid <= 1
    )
      throw Error('更新进程身份无效')
    await runPostExitUpdate({ root, application, profileHome, expected, hostPid, desktopPid })
  } catch {
    process.exitCode = 1
  }
}
