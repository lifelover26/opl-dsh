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
      'PROCESSOR_ARCHITECTURE',
      'PROCESSOR_ARCHITEW6432',
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
  /** Environment values required by the official installer, such as a pinned release. */
  environment?: Record<string, string>
  /** Version proven by this plan to remain compatible with the adapter. */
  expectedVersion?: string
}

function downloadAndRun(
  url: string,
  scriptArgs: string[] = [],
  environment?: Record<string, string>,
  expectedVersion?: string,
): MaintenancePlan {
  if (process.platform === 'win32')
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ([scriptblock]::Create((Invoke-RestMethod -Uri '${url}')))`,
      ],
      ...(environment ? { environment } : {}),
      ...(expectedVersion ? { expectedVersion } : {}),
    }
  const suffix = scriptArgs.length > 0 ? ' ' + scriptArgs.map(quoteForShell).join(' ') : ''
  return {
    // Kimi Code and MiniMax Code publish Bash installers. Invoking them through
    // `/bin/sh` works on macOS by accident and fails on dash-based Linux desktops.
    command: 'bash',
    args: [
      '-c',
      `set -eu; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT; curl --fail --silent --show-error --location '${url}' -o "$tmp"; bash "$tmp"${suffix}`,
    ],
    ...(environment ? { environment } : {}),
    ...(expectedVersion ? { expectedVersion } : {}),
  }
}

function npmGlobalInstall(
  packageName: string,
  extra: string[] = [],
  expectedVersion?: string,
): MaintenancePlan {
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', '--global', packageName, ...extra],
    npmGlobal: true,
    ...(expectedVersion ? { expectedVersion } : {}),
  }
}

/**
 * The ACP adapters are measured against these exact official releases. A newer npm
 * package is not silently treated as compatible merely because it still has a CLI
 * with the same name.
 */
const PINNED_COMPATIBLE_RELEASES = {
  'kimi-code': '2.1.1',
  opencode: '1.19.0',
  kilo: '7.8.8',
  pi: '1.2.0',
} as const

/** Quote fixed installer arguments before they enter the Bash command string. */
function quoteForShell(argument: string): string {
  return `'${argument.replace(/'/g, `'\\''`)}'`
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
    return downloadAndRun(
      process.platform === 'win32'
        ? 'https://chatgpt.com/codex/install.ps1'
        : 'https://chatgpt.com/codex/install.sh',
      [],
      { CODEX_NON_INTERACTIVE: '1' },
    )
  if (item.maintenanceAction === 'install' && item.id === 'antigravity')
    return downloadAndRun(
      process.platform === 'win32'
        ? 'https://antigravity.google/cli/install.ps1'
        : 'https://antigravity.google/cli/install.sh',
    )
  if (item.maintenanceAction === 'install' && item.id === 'claude')
    return downloadAndRun(
      process.platform === 'win32'
        ? 'https://claude.ai/install.ps1'
        : 'https://claude.ai/install.sh',
    )
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
    return npmGlobalInstall(
      `opencode-ai@${PINNED_COMPATIBLE_RELEASES.opencode}`,
      [],
      PINNED_COMPATIBLE_RELEASES.opencode,
    )
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'kilo')
    return npmGlobalInstall(
      `@kilocode/cli@${PINNED_COMPATIBLE_RELEASES.kilo}`,
      [],
      PINNED_COMPATIBLE_RELEASES.kilo,
    )
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'kimi-code')
    return downloadAndRun(
      process.platform === 'win32'
        ? 'https://code.kimi.com/kimi-code/install.ps1'
        : 'https://code.kimi.com/kimi-code/install.sh',
      [],
      { KIMI_VERSION: PINNED_COMPATIBLE_RELEASES['kimi-code'] },
      PINNED_COMPATIBLE_RELEASES['kimi-code'],
    )
  if (['install', 'update'].includes(item.maintenanceAction) && item.id === 'pi')
    return npmGlobalInstall(
      `@earendil-works/pi-coding-agent@${PINNED_COMPATIBLE_RELEASES.pi}`,
      ['--ignore-scripts'],
      PINNED_COMPATIBLE_RELEASES.pi,
    )
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
  const plan = maintenancePlan(item)
  const installerEnv = maintenanceEnvironment()
  if (plan.environment) Object.assign(installerEnv, plan.environment)
  const env = harnessProxyEnvironment(installerEnv, proxy)
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
      plan.expectedVersion ??
      (item.id === 'claude'
        ? stdout.match(/Successfully updated from \S+ to version (\d+\.\d+\.\d+)/)?.[1]
        : undefined)
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
