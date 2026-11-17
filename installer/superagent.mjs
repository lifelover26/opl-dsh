/** Open the original SuperAgent bundle in its own Desktop or Linux CLI/Web process. */
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launchIndependent } from './windows-lifecycle.mjs'
import { acquireSuiteLaunch } from './update-transaction.mjs'
import { openLoginPage } from './desktop-platform.mjs'

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

async function authenticatedSetupUrl(binding) {
  if (!binding) throw new Error('SuperAgent 控制入口尚未就绪')
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
  if (!location.ok || typeof location.value !== 'string') throw new Error('SuperAgent 地址尚未就绪')
  const url = new URL(location.value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error('SuperAgent 地址必须来自本机。')
  return url.href
}

export async function openSuperagent(installed, { start, open = openLoginPage } = {}) {
  const linux = process.platform === 'linux'
  if (process.platform !== 'darwin' && !linux)
    throw new Error(
      'SuperAgent 原型的账户与执行命令需要 POSIX 环境，本版提供 macOS 和 Linux 入口。',
    )
  const root = join(installed.suiteRoot, 'superagent')
  const home = join(root, 'home')
  const profileName = linux ? 'opl-superagent' : 'desktop'
  const profile = join(home, 'profiles', profileName)
  const executable = linux
    ? process.env.OPL_DSH_CLI || 'dsh'
    : join(installed.app, 'Contents/MacOS/DeepSeek Harness')
  const cliEnv = (extra = {}) => {
    const env = {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE: profileName,
      DSH_PROFILE_DIR: profile,
      OPL_PROFILE_NAME: profileName,
      ...extra,
    }
    delete env.ELECTRON_RUN_AS_NODE
    return env
  }
  const openLocation = (location) => {
    try {
      open(location)
    } catch (error) {
      throw new Error(
        `SuperAgent 已就绪，但无法打开浏览器：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const artifact = await read(join(installed.release, 'artifact.json'))
  const companion = artifact.superagent
  const plugins = artifact.plugins ?? []
  if (
    plugins.length &&
    (plugins.length !== 2 ||
      plugins.some(
        (plugin, index) =>
          plugin.package !==
            ['@one-person-lab/dsh-execution', '@one-person-lab/dsh-collaboration'][index] ||
          !/^opl-dsh-(execution|collaboration)-[a-zA-Z0-9.-]+\.tgz$/.test(plugin.name),
      ))
  )
    throw Error('SuperAgent 的 OPL 功能插件清单无效')
  if (!companion || !/^dsh-superagent-[a-f0-9]{12}\.tgz$/.test(companion.name))
    throw new Error('已安装套件缺少 SuperAgent，请更新 OPL DSH。')
  for (const [name, expected] of [
    [companion.name, companion.sha256],
    [artifact.name, artifact.sha256],
    ...plugins.map((plugin) => [plugin.name, plugin.sha256]),
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
  let suiteLaunch
  try {
    suiteLaunch = await acquireSuiteLaunch(installed.suiteRoot)
  } catch (error) {
    await unlink(lock).catch((unlinkError) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError
    })
    throw error
  }
  try {
    const binding = await read(join(profile, 'control.json')).catch(() => undefined)
    const launch = await read(join(root, 'launch.json')).catch(() => undefined)
    const running = alive(binding?.pid) || alive(launch?.pid)
    if (running) {
      if (linux && binding) {
        openLocation(await authenticatedSetupUrl(binding))
        return { state: 'opened' }
      }
      return { state: 'running' }
    }
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
        linux ? process.execPath : executable,
        [
          join(installed.release, 'profile.cjs'),
          installed.app,
          home,
          join(installed.release, artifact.name),
          join(installed.release, companion.name),
          ...plugins.map((plugin) => '--plugin=' + join(installed.release, plugin.name)),
        ],
        linux
          ? {
              env: cliEnv({ OPL_DSH_CLI_PROFILE: profileName }),
              timeout: 180000,
              maxBuffer: 1 << 20,
            }
          : {
              env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
              timeout: 180000,
              maxBuffer: 1 << 20,
            },
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
        profile: profileName,
      }) + '\n',
      { mode: 0o600 },
    )
    // The dedicated setup process takes this reservation while it publishes its own launcher.
    await suiteLaunch.release()
    const startLinux = () => {
      const log = openSync(join(root, 'desktop.log'), 'a', 0o600)
      try {
        return launchIndependent({
          command: executable,
          args: ['--profile', profileName, '--host', '127.0.0.1', '--port', '0', '--no-open'],
          env: cliEnv({
            OPL_SUITE_ROOT: installed.suiteRoot,
            OPL_OFFICIAL_VERSION: installed.officialVersion,
            NODE_USE_SYSTEM_CA: '1',
          }),
          label: 'superagent',
          stdio: ['ignore', log, log],
        })
      } finally {
        closeSync(log)
      }
    }
    const started = start
      ? await start({ home, root, app: installed.app })
      : linux
        ? startLinux()
        : launchIndependent({
            command: executable,
            args: [
              join(installed.release, 'setup.mjs'),
              home,
              root,
              installed.app,
              '--no-update',
              `--suite-root=${installed.suiteRoot}`,
            ],
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
      let location
      try {
        const binding = await read(join(profile, 'control.json'))
        const candidate = await authenticatedSetupUrl(binding)
        const url = new URL('/orchestrator/api/state', candidate)
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
          location = candidate
      } catch {}
      if (location) {
        if (linux) openLocation(location)
        return { state: 'opened' }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('SuperAgent 未在 90 秒内就绪，请检查独立目录中的 desktop.log。')
  } finally {
    await suiteLaunch.release()
    await unlink(lock)
  }
}
