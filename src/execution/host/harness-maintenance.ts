/** Official CLI updaters only. The plugin never accepts an arbitrary shell command. */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { HarnessInstallation } from '../contracts/installations.ts'
import type { HarnessProxy } from '../contracts/catalog.ts'
import { harnessProxyEnvironment } from './proxy.ts'
import {
  harnessSearchPath,
  commandLaunch,
  executablePath,
  npmGlobalBin,
  rememberHarnessInstallRoots,
  harnessDiagnostic,
} from './harness-registry.ts'
const exec = promisify(execFile)
export function maintenanceEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'SYSTEMROOT',
      'SystemRoot',
      'ComSpec',
      'PATHEXT',
      'TEMP',
      'TMP',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'CODEX_HOME',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'https_proxy',
      'http_proxy',
      'all_proxy',
      'no_proxy',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'NODE_EXTRA_CA_CERTS',
      'NODE_USE_SYSTEM_CA',
      'npm_config_prefix',
      'NPM_CONFIG_PREFIX',
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  ) as NodeJS.ProcessEnv
  env.PATH = harnessSearchPath()
  env.CI = '1'
  env.NO_COLOR = '1'
  env.npm_config_yes = 'true'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  env.npm_config_update_notifier = 'false'
  return env
}
export interface MaintenancePlan {
  command: string
  args: string[]
  npmGlobal?: boolean
}

function downloadAndRun(url: string, scriptArgs: string[] = []): MaintenancePlan {
  if (process.platform === 'win32')
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `& ([scriptblock]::Create((Invoke-RestMethod -Uri '${url}')))`,
      ],
    }
  const suffix = scriptArgs.length > 0 ? ' ' + scriptArgs.join(' ') : ''
  return {
    command: '/bin/sh',
    args: [
      '-c',
      `set -eu; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT; curl --fail --silent --show-error --location '${url}' -o "$tmp"; sh "$tmp"${suffix}`,
    ],
  }
}

function npmGlobalInstall(packageName: string, extra: string[] = []): MaintenancePlan {
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', '--global', packageName, ...extra],
    npmGlobal: true,
  }
}

export function maintenancePlan(item: HarnessInstallation): MaintenancePlan {
  if (!item.maintenanceAction) throw Error('请使用此 Harness 的官方安装与更新入口')
  if (
    item.maintenanceAction === 'update' &&
    ['codex', 'claude', 'grok-build', 'antigravity'].includes(item.id) &&
    item.path
  )
    return { command: item.path, args: ['update'] }
  if (item.maintenanceAction === 'install' && item.id === 'codex')
    return npmGlobalInstall('@openai/codex@latest')
  if (item.maintenanceAction === 'install' && item.id === 'claude')
    return process.platform === 'win32'
      ? {
          command: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            "& ([scriptblock]::Create((Invoke-RestMethod -Uri 'https://claude.ai/install.ps1')))",
          ],
        }
      : {
          ...downloadAndRun('https://claude.ai/install.sh'),
        }
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'minimax-code')
    return downloadAndRun(
      process.platform === 'win32'
        ? 'https://filecdn.minimax.chat/public/install.ps1'
        : 'https://filecdn.minimax.chat/public/install.sh',
    )
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'mimo-code')
    return downloadAndRun(
      process.platform === 'win32'
        ? 'https://mimo.xiaomi.com/install.ps1'
        : 'https://mimo.xiaomi.com/install',
      process.platform === 'win32' ? [] : ['--no-modify-path'],
    )
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'step-code')
    return downloadAndRun(
      process.platform === 'win32'
        ? 'https://static-openapi.stepfun.com/stepcode/install.ps1'
        : 'https://static-openapi.stepfun.com/stepcode/install.sh',
    )
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'opencode')
    return npmGlobalInstall('opencode-ai')
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'kilo')
    return npmGlobalInstall('@kilocode/cli')
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'kimi-code')
    return npmGlobalInstall('@moonshot-ai/kimi-code')
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'pi')
    return npmGlobalInstall('@earendil-works/pi-coding-agent', ['--ignore-scripts'])
  throw Error('此 Harness 没有自动更新入口')
}
export interface MaintenanceResult {
  message: string
  command: string
  expectedVersion?: string
  /** Actual launcher directories reported by the selected npm, queried only during maintenance. */
  installRoots?: string[]
}
/** Use the existing installation's official updater. */
export async function maintainHarness(
  item: HarnessInstallation,
  proxy?: HarnessProxy,
): Promise<MaintenanceResult> {
  const plan = maintenancePlan(item),
    env = harnessProxyEnvironment(maintenanceEnvironment(), proxy)
  if (item.path) env.PATH = [dirname(item.path), env.PATH].join(delimiter)
  let command = plan.command
  let installRoots: string[] | undefined
  let stage = plan.npmGlobal ? '安装依赖检查（尚未启动安装）' : '官方更新器'
  try {
    if (plan.npmGlobal) {
      const npm = await executablePath('npm')
      if (!npm) throw Error('安装依赖缺失：未找到 npm，请检查 npm.cmd/npm 的安装及 PATH。')
      command = npm
      stage = 'npm 全局目录查询（尚未启动安装）'
      const prefixLaunch = commandLaunch(npm, ['prefix', '--global'])
      const prefixPending = exec(prefixLaunch.command, prefixLaunch.args, {
        ...(prefixLaunch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        env,
        cwd: homedir(),
        timeout: 30000,
        maxBuffer: 16384,
        windowsHide: true,
      })
      prefixPending.child.stdin?.end()
      const { stdout } = await prefixPending
      const prefix = stdout.trim()
      if (!prefix || /[\r\n\0]/.test(prefix) || !isAbsolute(prefix))
        throw Error(`npm 未返回有效的全局安装目录：${harnessDiagnostic(stdout) || '输出为空'}`)
      installRoots = [npmGlobalBin(prefix)]
    }
    stage = '官方更新器'
    const launch = commandLaunch(command, plan.args)
    const pending = exec(launch.command, launch.args, {
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env,
      cwd: homedir(),
      timeout: 600000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    pending.child.stdin?.end()
    const { stdout, stderr } = await pending
    const expectedVersion =
      item.id === 'claude'
        ? stdout.match(/Successfully updated from \S+ to version (\d+\.\d+\.\d+)/)?.[1]
        : undefined
    if (installRoots) rememberHarnessInstallRoots(installRoots)
    return {
      command,
      message: [
        harnessDiagnostic(stdout + '\n' + stderr) || '官方更新器执行完成',
        ...(installRoots ? [`npm 全局启动目录：${installRoots.join('、')}`] : []),
      ].join('\n'),
      ...(expectedVersion ? { expectedVersion } : {}),
      ...(installRoots ? { installRoots } : {}),
    }
  } catch (error) {
    const detail = error as {
      code?: string | number
      stdout?: string
      stderr?: string
      killed?: boolean
      message?: string
    }
    const reason = detail.killed
      ? '超时'
      : typeof detail.code === 'number'
        ? `退出码 ${detail.code}`
        : `启动失败${detail.code ? ` ${detail.code}` : ''}`
    throw Error(
      `${stage}未完成（${reason}）：${harnessDiagnostic((detail.stderr ?? '') + '\n' + (detail.stdout ?? '')) || harnessDiagnostic(detail.message ?? '')}\n启动入口：${command}${installRoots ? `\nnpm 全局启动目录：${installRoots.join('、')}` : ''}`,
    )
  }
}
