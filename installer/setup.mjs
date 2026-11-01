import { refreshEnhancements } from './update.mjs'
import { WINDOWS_KIMI_CU_VERSION } from './kimi-cu-windows.mjs'
/** Launch the signed official app; let the OPL plugin own the in-app first run.
 * The native welcome bridge uses a private Chromium pipe (no TCP debugging
 * port). If a future desktop does not expose the skip operation, its own
 * welcome window remains available.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { openSync, closeSync, readFileSync } from 'node:fs'
const [home, root, application] = process.argv.slice(2)
if (!home || !root || !application) throw new Error('缺少桌面启动路径')
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
