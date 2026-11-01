/** Open the original SuperAgent bundle in its own official Desktop process. */
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launchIndependent } from './windows-lifecycle.mjs'

const execute = promisify(execFile)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const read = async (path) => JSON.parse(await readFile(path, 'utf8'))
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

export async function openSuperagent(installed, { start } = {}) {
  if (process.platform !== 'darwin')
    throw new Error('SuperAgent 原型的账户与执行命令需要 POSIX 环境，本版提供 macOS 入口。')
  const root = join(installed.suiteRoot, 'superagent')
  const home = join(root, 'home')
  const profile = join(home, 'profiles/desktop')
  const executable = join(installed.app, 'Contents/MacOS/DeepSeek Harness')
  const artifact = await read(join(installed.release, 'artifact.json'))
  const companion = artifact.superagent
  if (!companion || !/^dsh-superagent-[a-f0-9]{12}\.tgz$/.test(companion.name))
    throw new Error('已安装套件缺少 SuperAgent，请更新 OPL DSH。')
  for (const [name, expected] of [
    [companion.name, companion.sha256],
    [artifact.name, artifact.sha256],
  ]) {
    if (digest(await readFile(join(installed.release, name))) !== expected)
      throw new Error('SuperAgent 安装包校验失败。')
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lock = join(root, 'prepare.lock')
  const previousLock = await read(lock).catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (previousLock) {
    if (alive(previousLock.pid)) throw new Error('SuperAgent 正在准备，请稍后重试。')
    await unlink(lock)
  }
  await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
  try {
    const binding = await read(join(profile, 'control.json')).catch(() => undefined)
    const launch = await read(join(root, 'launch.json')).catch(() => undefined)
    const running = alive(binding?.pid) || alive(launch?.pid)
    if (running) return { state: 'running' }
    const current = await read(join(root, 'installation.json')).catch(() => undefined)
    if (current?.suiteSha256 !== artifact.suiteSha256) {
      await mkdir(profile, { recursive: true, mode: 0o700 })
      try {
        await writeFile(
          join(profile, 'cordis.patch.yml'),
          '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n' +
            '- id: dsh-superagent\n  config:\n    stateDir: ' +
            JSON.stringify(join(root, 'state')) +
            '\n',
          { flag: 'wx', mode: 0o600 },
        )
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      await execute(
        executable,
        [
          join(installed.release, 'profile.cjs'),
          installed.app,
          home,
          join(installed.release, artifact.name),
          join(installed.release, companion.name),
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 180000, maxBuffer: 1 << 20 },
      )
      await writeFile(
        join(root, 'installation.json'),
        JSON.stringify({
          suiteSha256: artifact.suiteSha256,
          release: installed.release,
        }) + '\n',
        { mode: 0o600 },
      )
    }
    // Keep the primary Suite receipt and personal Skill untouched.
    await mkdir(join(home, 'opl-dsh'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(home, 'opl-dsh/installation.json'),
      JSON.stringify({
        ...installed,
        home,
        profileHome: home,
      }) + '\n',
      { mode: 0o600 },
    )
    const started = start
      ? await start({ home, root, app: installed.app })
      : launchIndependent({
          command: executable,
          args: [join(installed.release, 'setup.mjs'), home, root, installed.app, '--no-update'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          label: 'superagent',
        })
    if (started.refusal) throw new Error(started.refusal)
    await writeFile(join(root, 'launch.json'), JSON.stringify({ pid: started.pid }) + '\n', {
      mode: 0o600,
    })
    for (let attempt = 0; attempt < 180; attempt++) {
      if (!alive(started.pid))
        throw new Error('SuperAgent 桌面提前退出，请检查独立目录中的 desktop.log。')
      try {
        const binding = await read(join(profile, 'control.json'))
        const endpoint = new URL(binding.endpoint)
        if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
          throw new Error('SuperAgent 控制入口必须来自本机。')
        const control = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
          body: JSON.stringify({ namespace: 'oplSuite', method: 'setupUrl', args: {} }),
          signal: AbortSignal.timeout(2000),
        })
        const location = await control.json()
        if (!location.ok || typeof location.value !== 'string') continue
        const url = new URL('/orchestrator/api/state', location.value)
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
          throw new Error('SuperAgent 地址必须来自本机。')
        const response = await fetch(url, {
          headers: { 'x-orchestrator-request': '1' },
          signal: AbortSignal.timeout(2000),
        })
        const state = await response.json()
        if (
          response.ok &&
          typeof state.setup?.machine?.stateDir === 'string' &&
          isAbsolute(state.setup.machine.stateDir)
        )
          return { state: 'opened' }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('SuperAgent 未在 90 秒内就绪，请检查独立目录中的 desktop.log。')
  } finally {
    await unlink(lock)
  }
}
