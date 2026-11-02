import { access, constants, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, delimiter, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HarnessDefinition } from '../contracts/catalog.ts'
import type { HarnessInstallation } from '../contracts/installations.ts'
const exec = promisify(execFile)
const info: Record<
  string,
  { command: string; website: string; instructions: string; installable?: boolean }
> = {
  'grok-build': {
    command: join(homedir(), '.grok/bin/grok'),
    website: 'https://grok.com/build',
    instructions: '使用 Grok Build 官方安装器安装或更新；安装后重新检测。',
  },
  codex: {
    command: 'codex',
    website: 'https://developers.openai.com/codex/cli/',
    instructions: '已安装时使用官方 codex update；未安装时可一键使用官方 npm 安装器。',
    installable: true,
  },
  claude: {
    command: 'claude',
    website: 'https://code.claude.com/docs/en/setup',
    instructions: '已安装时使用官方 claude update；未安装时可一键使用 Claude 官方安装器。',
    installable: true,
  },
  antigravity: {
    command: 'agy',
    website: 'https://antigravity.google/docs',
    instructions: '使用 agy update 检查并更新 Antigravity CLI。',
  },
  'minimax-code': {
    command: process.platform === 'win32' ? 'mcode.cmd' : 'mcode',
    website: 'https://github.com/MiniMax-AI/minimax-code',
    instructions:
      '可使用 MiniMax 官方安装器安装 mcode；登录请在终端运行 mcode login，凭据由官方 CLI 自行保存与刷新。',
    installable: true,
  },
  zcode: {
    command: 'zcode',
    website: 'https://github.com/zai-org/ZCode/releases',
    instructions: '使用官方 ZCode CLI 的 app-server 入口；模型连接由 OFM 模型服务管理。',
  },
  'kimi-code': {
    command: 'kimi',
    website: 'https://www.npmjs.com/package/@moonshot-ai/kimi-code',
    instructions: '可使用 Kimi Code 官方 npm 包安装 kimi；模型连接由模型供应商管理。',
    installable: true,
  },
  'mimo-code': {
    command: 'mimo',
    website: 'https://github.com/XiaomiMiMo/MiMo-Code',
    instructions: '可使用 MiMo Code 官方安装器安装 mimo；模型连接由模型供应商管理。',
    installable: true,
  },
  pool: {
    command: 'pool',
    website: 'https://poolside.ai',
    instructions: '使用 Poolside 官方安装方式安装 pool；适配接口要求 1.0.16。',
  },
  'step-code': {
    command: 'step',
    website: 'https://github.com/stepfun-ai/Step-Code',
    instructions: '可使用 StepCode 官方安装器安装 step；模型连接由模型供应商管理。',
    installable: true,
  },
  'muse-code': {
    command: 'muse',
    website: 'https://dev.meta.ai/docs/muse-code',
    instructions: '使用 Muse Code 官方安装方式安装 muse；模型连接由模型供应商管理。',
  },
  opencode: {
    command: 'opencode',
    website: 'https://opencode.ai',
    instructions: '可使用 OpenCode 官方 npm 包安装 opencode；模型连接由模型供应商管理。',
    installable: true,
  },
  vibe: {
    command: 'vibe-acp',
    website: 'https://github.com/mistralai/mistral-vibe/releases/tag/v3.0.4',
    instructions: '安装官方 Mistral Vibe 3.0.4，并登记 vibe-acp 的绝对路径；模型连接由 OFM 管理。',
  },
  pi: {
    command: 'pi',
    website: 'https://github.com/badlogic/pi-mono',
    instructions: '可使用 Pi Coding Agent 官方安装器安装 pi；模型连接由模型供应商管理。',
    installable: true,
  },
  kilo: {
    command: 'kilo',
    website: 'https://github.com/Kilo-Org/kilocode',
    instructions: '可使用 Kilo Code 官方 npm 包安装 kilo；模型连接由模型供应商管理。',
    installable: true,
  },
}
/**
 * Directories the official MiniMax Code installer writes its launcher into. The
 * Windows launcher is `mcode.cmd`, which no Execute permission or extensionless
 * lookup can find, so the exact names are checked explicitly.
 */
export function minimaxCodeRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE || env.HOME || homedir()
  return [env.MINIMAX_CODE_HOME, join(home, '.minimax-code')].filter(
    (value): value is string => !!value,
  )
}
const knownRoots = (id: string): string[] => {
  const home = homedir()
  const roots = [
    join(home, '.local/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.volta/bin'),
    join(home, '.asdf/shims'),
    join(home, '.local/share/mise/shims'),
    join(home, '.cargo/bin'),
    join(home, '.claude/local'),
    join(home, '.claude/local/bin'),
    process.env.npm_config_prefix ? join(process.env.npm_config_prefix, 'bin') : '',
    process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  if (id === 'codex')
    roots.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS',
      join(
        home,
        'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS',
      ),
      ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs/codex')] : []),
    )
  if (id === 'claude' && process.env.LOCALAPPDATA)
    roots.push(join(process.env.LOCALAPPDATA, 'Programs/Claude Code'))
  if (id === 'minimax-code') roots.push(...minimaxCodeRoots())
  if (id === 'mimo-code') roots.push(join(home, '.mimocode/bin'))
  if (id === 'kimi-code') roots.push(join(home, '.local/bin'), join(home, '.kimi-code/bin'))
  if (id === 'step-code') roots.push(join(home, '.stepcode/bin'))
  return [...new Set(roots.filter(Boolean))]
}
function candidatePaths(
  command: string,
  id?: string,
): Array<{ path: string; detectedBy: NonNullable<HarnessInstallation['detectedBy']> }> {
  if (isAbsolute(command)) return [{ path: command, detectedBy: 'configured-path' }]
  const roots = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const known = id ? knownRoots(id) : []
  return [
    ...roots.map((root) => ({ path: join(root, command), detectedBy: 'shell-path' as const })),
    ...known.map((root) => ({ path: join(root, command), detectedBy: 'known-path' as const })),
    ...roots.flatMap((root) =>
      process.platform === 'win32'
        ? ['.exe', '.cmd', '.bat'].map((ext) => ({
            path: join(root, command + ext),
            detectedBy: 'shell-path' as const,
          }))
        : [],
    ),
    ...known.flatMap((root) =>
      process.platform === 'win32'
        ? ['.exe', '.cmd', '.bat'].map((ext) => ({
            path: join(root, command + ext),
            detectedBy: 'known-path' as const,
          }))
        : [],
    ),
  ]
}
async function shellResolved(command: string, id: string): Promise<string | undefined> {
  if (!info[id] || isAbsolute(command) || !/^[A-Za-z0-9_.-]+$/.test(command)) return undefined
  const shell =
    process.platform === 'win32'
      ? 'where.exe'
      : process.env.SHELL?.startsWith('/')
        ? process.env.SHELL
        : '/bin/sh'
  try {
    const result =
      process.platform === 'win32'
        ? await exec(shell, [command], { timeout: 3000, maxBuffer: 4096 })
        : await exec(shell, ['-lc', `command -v ${command}`], { timeout: 3000, maxBuffer: 4096 })
    return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || undefined
  } catch {
    return undefined
  }
}
export function harnessSearchPath(): string {
  return [
    ...new Set(
      [
        process.env.PATH ?? '',
        ...knownRoots('codex'),
        ...knownRoots('claude'),
        ...knownRoots('minimax-code'),
      ].filter(Boolean),
    ),
  ].join(delimiter)
}
export interface CommandLaunch {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}
/**
 * Resolve how to start a discovered CLI entry point.
 *
 * A Windows `.cmd`/`.bat` shim is not an executable image, so it must run through
 * `cmd.exe`. `cmd /S` strips only the outermost quote pair, which is why the script
 * path stays inside a second pair and the whole vector must reach cmd verbatim:
 * Node's default Windows escaping would turn those inner quotes into `\"`, which cmd
 * reads as literal backslashes and then fails to resolve the script at all. Paths
 * containing spaces (the normal case under `Program Files`) depend on this.
 *
 * @param path - discovered executable or script path.
 * @param args - arguments appended to the script.
 * @returns the command, argument vector, and the verbatim flag when cmd is involved.
 * @throws when an argument cannot be passed through cmd.exe without being reinterpreted.
 */
export function commandLaunch(path: string, args: readonly string[] = []): CommandLaunch {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(path))
    return { command: path, args: [...args] }
  for (const argument of args)
    if (/["%^&|<>()\r\n]/.test(argument))
      throw Error(`无法安全地通过 cmd.exe 传递参数：${argument}`)
  const line = [`"${path}"`, ...args.map(quoteForCmd)].join(' ')
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  }
}
/** cmd.exe splits on whitespace, so an argument containing any must be quoted. */
function quoteForCmd(argument: string): string {
  return /\s/.test(argument) ? `"${argument}"` : argument
}
export async function executablePath(command: string, id?: string): Promise<string | undefined> {
  for (const { path } of candidatePaths(
    command,
    id ?? (['codex', 'claude'].includes(command) ? command : undefined),
  ))
    if (
      await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path
  const resolved = await shellResolved(command, id ?? command)
  if (
    resolved &&
    (await access(resolved, process.platform === 'win32' ? constants.F_OK : constants.X_OK).then(
      () => true,
      () => false,
    ))
  )
    return resolved
  return undefined
}
export async function inspectHarness(
  harness: HarnessDefinition,
  home: string,
  grokCommand?: string,
): Promise<HarnessInstallation> {
  if (harness.kind === 'dsh') {
    const receipt = JSON.parse(
      await readFile(join(home, 'opl-dsh/installation.json'), 'utf8').catch(() => '{}'),
    )
    return {
      id: harness.id,
      name: harness.name,
      installed: true,
      runnable: true,
      version: process.env.OPL_OFFICIAL_VERSION ?? receipt.officialVersion ?? '由官方桌面提供',
      instructions: '内置于官方桌面，使用桌面的检查更新。',
      website: 'https://github.com/deepseek-ai/deepseek-harness/releases',
    }
  }
  const entry = info[harness.id],
    command =
      harness.command ?? (harness.kind === 'grok-build' ? grokCommand : undefined) ?? entry?.command
  const candidates = command ? candidatePaths(command, harness.id) : []
  let path: string | undefined
  let detectedBy: HarnessInstallation['detectedBy']
  for (const candidate of candidates) {
    const ok = await access(
      candidate.path,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    ).then(
      () => true,
      () => false,
    )
    if (ok) {
      path = candidate.path
      detectedBy = candidate.detectedBy
      break
    }
  }
  if (!path && command) {
    const resolved = await shellResolved(command, harness.id)
    if (
      resolved &&
      (await access(resolved, process.platform === 'win32' ? constants.F_OK : constants.X_OK).then(
        () => true,
        () => false,
      ))
    ) {
      path = resolved
      detectedBy = 'shell-path'
    }
  }
  const maintenanceAction = entry?.installable
    ? path
      ? 'update'
      : 'install'
    : path && ['grok-build', 'antigravity'].includes(harness.id)
      ? 'update'
      : undefined
  const base = {
    id: harness.id,
    name: harness.name,
    installed: !!path,
    runnable:
      !!path &&
      (harness.kind === 'grok-build' ||
        (Object.hasOwn(info, harness.id) && harness.id !== 'antigravity')),
    instructions: entry?.instructions ?? '使用此 Harness 的官方安装与更新方式。',
    website: entry?.website ?? '',
    ...(entry?.installable ? { installable: true } : {}),
    ...(maintenanceAction ? { maintenanceAction: maintenanceAction as 'install' | 'update' } : {}),
  }
  if (!path) return { ...base, error: '未找到可执行文件；可使用一键安装或查看官方入口' }
  // ZCode's launcher is a desktop entry point on some installations. Running
  // `zcode --version` during settings discovery can briefly open its window.
  // Presence is enough for the settings card; version discovery belongs to the
  // official CLI and must never make opening Settings visible.
  if (harness.id === 'zcode') return { ...base, path, ...(detectedBy ? { detectedBy } : {}) }
  try {
    const launch = commandLaunch(path, [...(harness.prefix ?? []), '--version'])
    const { stdout, stderr } = await exec(launch.command, launch.args, {
      ...(launch.windowsVerbatimArguments
        ? { windowsVerbatimArguments: launch.windowsVerbatimArguments }
        : {}),
      timeout: 5000,
      maxBuffer: 4096,
      env: {
        ...Object.fromEntries(
          [
            'PATH',
            'HOME',
            'USERPROFILE',
            'APPDATA',
            'LOCALAPPDATA',
            'SYSTEMROOT',
            'TEMP',
            'TMP',
            'TMPDIR',
            'LANG',
            'LC_ALL',
            'CODEX_HOME',
          ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
        ),
      },
    })
    const version = (stdout || stderr).trim().split(/\r?\n/)[0]?.slice(0, 150)
    return { ...base, path, ...(detectedBy ? { detectedBy } : {}), ...(version ? { version } : {}) }
  } catch {
    return {
      ...base,
      path,
      ...(detectedBy ? { detectedBy } : {}),
      error: '已发现可执行文件，版本检测未成功',
    }
  }
}
