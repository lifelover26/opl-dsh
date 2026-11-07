import { refreshEnhancements } from './update.mjs'
import { WINDOWS_KIMI_CU_VERSION } from './kimi-cu-windows.mjs'
import {
  acquireSuiteLaunch,
  finishUpdateTransaction,
  readUpdateTransaction,
} from './update-transaction.mjs'
import {
  prepareUnattendedTransaction,
  launchUpdateRunner,
  acknowledgeUpdateShutdown,
} from './update-runner.mjs'
import { serveDesktopUpdate } from './desktop-update.mjs'
/** Launch the signed official app; let the OPL plugin own the in-app first run.
 * The native welcome bridge uses a private Chromium pipe (no TCP debugging
 * port). If a future desktop does not expose the skip operation, its own
 * welcome window remains available.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { openSync, closeSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const [home, root, application] = process.argv.slice(2)
if (!home || !root || !application) throw new Error('缺少桌面启动路径')
const flag = (name) =>
  process.argv.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1)
const suiteRoot = resolve(flag('--suite-root') ?? root)
const transactionId = flag('--update-transaction')
const transactionNonce = flag('--update-nonce')
if (suiteRoot !== resolve(root) && resolve(root) !== resolve(join(suiteRoot, 'superagent')))
  throw new Error('桌面套件目录不匹配')
const isProcessAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
const existingLaunch = JSON.parse(
  await readFile(join(root, 'desktop-launch.json'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '{}'
    throw error
  }),
)
if (Object.keys(existingLaunch).length) {
  if (
    existingLaunch.schemaVersion !== 1 ||
    typeof existingLaunch.nonce !== 'string' ||
    !Number.isSafeInteger(existingLaunch.launcherPid) ||
    !Number.isSafeInteger(existingLaunch.desktopPid) ||
    typeof existingLaunch.application !== 'string' ||
    typeof existingLaunch.profileHome !== 'string'
  )
    throw new Error('现有桌面启动记录无法核验，拒绝覆盖。')
  if (isProcessAlive(existingLaunch.launcherPid) || isProcessAlive(existingLaunch.desktopPid)) {
    const sameLaunch =
      resolve(existingLaunch.application) === resolve(application) &&
      resolve(existingLaunch.profileHome) === resolve(home)
    throw new Error(
      sameLaunch
        ? '官方桌面已在运行，请先退出后再启动。'
        : '另一套桌面仍在运行，拒绝覆盖启动记录。',
    )
  }
}
const launchLease = await acquireSuiteLaunch(
  suiteRoot,
  transactionId ? { transactionId, nonce: transactionNonce } : {},
)
if (!process.argv.includes('--no-update')) await refreshEnhancements(root, application)
const executable =
  process.platform === 'win32'
    ? join(application, 'DeepSeek Harness.exe')
    : join(application, 'Contents/MacOS/DeepSeek Harness')
const resources =
  process.platform === 'win32'
    ? join(application, 'resources')
    : join(application, 'Contents/Resources')
const manifest = JSON.parse(readFileSync(join(resources, 'app.asar/package.json'), 'utf8'))
const env = {
  ...process.env,
  DSH_HOME: home,
  OPL_SUITE_ROOT: suiteRoot,
  OPL_LAUNCHER_PID: String(process.pid),
  OPL_UPDATE_TRANSACTION_ID: transactionId ?? '',
  OPL_UPDATE_TRANSACTION_NONCE: transactionNonce ?? '',
  OPL_UPDATE_LAUNCHER_PID: transactionId ? String(process.pid) : '',
  NODE_USE_SYSTEM_CA: '1',
  OPL_OFFICIAL_VERSION: manifest.version,
  ...(process.platform === 'win32'
    ? { OPL_KIMI_CU_WINDOWS_ROOT: join(root, 'kimi-cu', WINDOWS_KIMI_CU_VERSION) }
    : {}),
}
delete env.ELECTRON_RUN_AS_NODE
const log = openSync(join(root, 'desktop.log'), 'a', 0o600)
// The Suite launcher creates this process outside the calling Windows Job.
// Keep the official app's private CDP pipes in this owned launcher process.
const child = spawn(
  executable,
  ['--user-data-dir=' + join(root, 'electron'), '--remote-debugging-pipe'],
  { env, stdio: ['ignore', log, log, 'pipe', 'pipe'] },
)
closeSync(log)
const current = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'))
let privateControl
let updateClosing = false
let updateLease
let updateClaimed = false
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
async function inspectUpdate(hostPid, allowHandoff = false) {
  const control = JSON.parse(await readFile(join(home, 'profiles/desktop/control.json'), 'utf8'))
  if (control.pid !== hostPid || !alive(hostPid) || child.exitCode !== null || updateClosing)
    return { available: false }
  for (const profileHome of [home, join(root, 'superagent', 'home')]) {
    let profiles
    try {
      profiles = await readdir(join(profileHome, 'profiles'), { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const profile of profiles) {
      if (profile.isSymbolicLink()) return { available: false, otherProfile: true }
      if (!profile.isDirectory()) continue
      let state
      try {
        state = JSON.parse(
          await readFile(join(profileHome, 'profiles', profile.name, 'control.json'), 'utf8'),
        )
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      if (!Number.isSafeInteger(state.pid) || state.pid <= 0) throw Error('无法核验 profile')
      if (
        alive(state.pid) &&
        (resolve(profileHome) !== resolve(home) ||
          profile.name !== 'desktop' ||
          state.pid !== hostPid)
      )
        return { available: false, otherProfile: true }
    }
  }
  const { targetInfos } = await call('Target.getTargets')
  const page = targetInfos.find(
    (item) => item.type === 'page' && item.url.startsWith('dsh-app://app/'),
  )
  if (!page) return { available: false }
  const { sessionId } = await call('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  })
  try {
    const state = await call(
      'Runtime.evaluate',
      {
        expression: 'window.dshDesktop.updates.status()',
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    )
    const phase = state.result?.value?.phase
    return {
      available:
        !state.exceptionDetails &&
        (['idle', 'available', 'error'].includes(phase) || (allowHandoff && phase === 'handoff')),
    }
  } finally {
    await call('Target.detachFromTarget', { sessionId })
  }
}
async function requestQuit(lease, hostPid) {
  updateClosing = true
  try {
    // Browser.close requests the owned Electron application's complete quit path.
    await call('Browser.close')
  } catch {
    /* A successful quit may close the pipe before the command response. */
  }
  const deadline = Date.now() + 30_000
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 100))
  if (child.exitCode !== 0 || child.signalCode !== null) {
    updateClosing = false
    return
  }
  try {
    const marker = JSON.parse(
      await readFile(join(root, 'updates', lease.id, 'host-drained.json'), 'utf8'),
    )
    if (
      marker.transactionId !== lease.id ||
      marker.nonce !== lease.nonce ||
      marker.hostPid !== hostPid ||
      marker.clean !== true
    )
      return
    await acknowledgeUpdateShutdown(root, lease, {
      hostPid,
      launcherPid: process.pid,
      desktopPid: child.pid,
      clean: true,
    })
  } finally {
    await privateControl?.close()
  }
}
let next = 0,
  buffer = '',
  stopped = false
const pending = new Map()
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('桌面欢迎流程响应超时'))
    }, 10000)
    pending.set(id, { timer, resolve, reject })
    child.stdio[3].write(
      JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
      (error) => {
        if (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      },
    )
  })
}
function stop() {
  stopped = true
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(new Error('桌面已退出'))
  }
  pending.clear()
}
child.once('error', () => {
  console.error('无法启动官方桌面')
  stop()
  process.exitCode = 1
})
child.once('exit', (code) => {
  stop()
  process.exitCode = code ?? 0
  if (!updateClosing) void privateControl?.close()
})
child.stdio[3].on('error', stop)
child.stdio[4].on('error', stop)
child.stdio[4].on('data', (bytes) => {
  buffer += bytes
  let boundary
  while ((boundary = buffer.indexOf('\0')) >= 0) {
    let message
    try {
      message = JSON.parse(buffer.slice(0, boundary))
    } catch {
      stop()
      return
    }
    buffer = buffer.slice(boundary + 1)
    const item = pending.get(message.id)
    if (item) {
      clearTimeout(item.timer)
      pending.delete(message.id)
      message.error ? item.reject(new Error('桌面欢迎接口不可用')) : item.resolve(message.result)
    }
  }
})
try {
  privateControl = await serveDesktopUpdate(
    root,
    {
      application: resolve(application),
      profileHome: resolve(home),
      desktopPid: child.pid,
      suiteSha256: current.suiteSha256,
      ...(transactionId ? { transactionId } : {}),
    },
    async (request) => {
      if (request.method === 'inspect') return inspectUpdate(request.hostPid)
      if (request.method === 'prepare') {
        if (!(await inspectUpdate(request.hostPid, true)).available || updateLease)
          throw Error('Desktop cannot update now')
        updateLease = await prepareUnattendedTransaction({
          root,
          application,
          profileHome: home,
          desktop: {
            nonce: privateControl.record.nonce,
            launcherPid: process.pid,
            desktopPid: child.pid,
            hostPid: request.hostPid,
          },
        })
        updateClaimed = true
        if (!(await inspectUpdate(request.hostPid, true)).available) {
          await finishUpdateTransaction(root, updateLease, {
            stage: 'failed',
            failure: 'other-profile-running',
          })
          updateClaimed = false
          updateLease = undefined
          throw Error('Another Desktop profile started before update handoff')
        }
        try {
          await launchUpdateRunner(root, updateLease)
        } catch (error) {
          updateClaimed = false
          updateLease = undefined
          throw error
        }
        return { id: updateLease.id, nonce: updateLease.nonce }
      }
      if (
        !updateLease ||
        !updateClaimed ||
        updateLease.id !== request.id ||
        updateLease.nonce !== request.transactionNonce ||
        updateClosing
      )
        throw Error('Update handoff changed')
      const state = await readUpdateTransaction(root, updateLease)
      if (state.stage !== 'waiting-exit' || !(await inspectUpdate(request.hostPid)).available)
        throw Error('Update runner is not ready')
      return {
        value: { accepted: true },
        afterReply: () => {
          void requestQuit(updateLease, request.hostPid).catch(() => {})
        },
      }
    },
  )
} finally {
  await launchLease.release()
}
// Forward an explicit launcher shutdown, never terminate a separate user process.
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    child.kill(signal)
  })
try {
  let entered = false
  for (let n = 0; n < 120 && !stopped && !entered; n++) {
    const { targetInfos } = await call('Target.getTargets')
    const welcome = targetInfos.find(
      (target) =>
        target.type === 'page' &&
        target.url.startsWith('file:') &&
        target.url.endsWith('/app.asar/renderer/welcome.html'),
    )
    if (welcome) {
      const { sessionId } = await call('Target.attachToTarget', {
        targetId: welcome.targetId,
        flatten: true,
      })
      const check = await call(
        'Runtime.evaluate',
        { expression: 'typeof window.dshWelcome?.skip', returnByValue: true },
        sessionId,
      )
      if (check.result?.value === 'function') {
        const outcome = await call(
          'Runtime.evaluate',
          { expression: 'window.dshWelcome.skip()', awaitPromise: true, returnByValue: true },
          sessionId,
        )
        if (outcome.exceptionDetails) throw new Error('官方欢迎窗口未能继续')
        entered = true
      } else await call('Target.detachFromTarget', { sessionId })
    }
    if (!entered) await new Promise((resolve) => setTimeout(resolve, 250))
  }
} catch {
  if (!stopped)
    console.error(
      '未能自动衔接首次设置。请在官方欢迎窗口选择 API Key → 稍后设置，随后可在应用内登录 OPL Gateway。',
    )
}
// The pipe remains private for this app lifetime; no further evaluation occurs.
