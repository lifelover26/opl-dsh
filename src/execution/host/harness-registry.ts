import { access, constants, opendir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, delimiter, isAbsolute, extname, resolve, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HarnessDefinition } from '../contracts/catalog.ts'
import type { HarnessInstallation } from '../contracts/installations.ts'
const exec = promisify(execFile)
type DetectedCommand = {
  path: string
  detectedBy: NonNullable<HarnessInstallation['detectedBy']>
}
type NativeCodexEntries = { entries: DetectedCommand[]; limited?: boolean }
const installedRoots = new Set<string>()

/** npm puts global launchers directly in the prefix on Windows, and in bin elsewhere. */
export function npmGlobalBin(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? prefix : join(prefix, 'bin')
}

/** Retain roots learned from an explicit installation without running npm during discovery. */
export function rememberHarnessInstallRoots(roots: readonly string[]): void {
  for (const root of roots) if (isAbsolute(root)) installedRoots.add(root)
  while (installedRoots.size > 16) installedRoots.delete(installedRoots.values().next().value!)
}
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
    npmGlobalBin(join(home, '.npm-global')),
    join(home, '.volta/bin'),
    join(home, '.asdf/shims'),
    join(home, '.local/share/mise/shims'),
    join(home, '.cargo/bin'),
    join(home, '.claude/local'),
    join(home, '.claude/local/bin'),
    ...(process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX
      ? [npmGlobalBin((process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX)!)]
      : []),
    ...installedRoots,
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
function configuredPath(command: string): boolean {
  return isAbsolute(command) || /[\\/]/.test(command)
}

function commandNames(command: string): string[] {
  if (process.platform !== 'win32' || extname(command)) return [command]
  const suffixes = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((suffix) => suffix.toLowerCase())
    .filter((suffix) => /^\.(exe|com|cmd|bat)$/.test(suffix))
  // npm also writes an extensionless POSIX shell script; Windows cannot execute it.
  return [...new Set([...suffixes, '.exe', '.cmd', '.bat', '.com'])].map(
    (suffix) => command + suffix,
  )
}

function candidatePaths(
  command: string,
  id?: string,
  installRoots: readonly string[] = [],
): DetectedCommand[] {
  if (configuredPath(command)) return [{ path: resolve(command), detectedBy: 'configured-path' }]
  const roots = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const known = [...installRoots, ...(id ? knownRoots(id) : [])]
  return [
    ...roots.flatMap((root) =>
      commandNames(command).map((name) => ({
        path: resolve(root.replace(/^"(.*)"$/, '$1'), name),
        detectedBy: 'shell-path' as const,
      })),
    ),
    ...known.flatMap((root) =>
      commandNames(command).map((name) => ({
        path: resolve(root, name),
        detectedBy: 'known-path' as const,
      })),
    ),
  ]
}

async function executableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Inspect direct children of the Windows Codex desktop bin directory, without choosing a release. */
async function nativeCodexEntries(): Promise<NativeCodexEntries> {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return { entries: [] }
  const root = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
  const directory = await opendir(root).catch(() => undefined)
  if (!directory) return { entries: [] }
  const entries: DetectedCommand[] = []
  let inspected = 0
  // Desktop release directories have opaque names. Their ordering says nothing
  // about the active release, so only a unique result can be an automatic fallback.
  for await (const entry of directory) {
    if (++inspected > 32) return { entries, limited: true }
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, 'codex.exe')
    if (!(await executableFile(path))) continue
    if (entries.length === 8) return { entries, limited: true }
    entries.push({ path, detectedBy: 'app-bundle' })
  }
  return { entries }
}

const shellCache = new Map<string, { expires: number; result: Promise<string | undefined> }>()
async function shellResolved(command: string, id: string): Promise<string | undefined> {
  if (
    process.platform === 'win32' ||
    (!info[id] && id !== 'npm') ||
    !/^[A-Za-z0-9_.-]+$/.test(command)
  )
    return undefined
  const shell = process.env.SHELL?.startsWith('/') ? process.env.SHELL : '/bin/sh'
  const key = JSON.stringify([command, shell, process.env.PATH, process.env.HOME])
  const cached = shellCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.result
  const result = exec(shell, ['-lc', `command -v ${command}`], { timeout: 3000, maxBuffer: 4096 })
    .then(({ stdout }) =>
      stdout
        .trim()
        .split(/\r?\n/)
        .find((line) => isAbsolute(line)),
    )
    .catch(() => undefined)
  shellCache.set(key, { expires: Date.now() + 60000, result })
  while (shellCache.size > 64) shellCache.delete(shellCache.keys().next().value!)
  return result
}
export function harnessSearchPath(): string {
  return [
    ...new Set(
      [
        process.env.PATH ?? '',
        ...knownRoots('codex'),
        ...knownRoots('claude'),
        ...knownRoots('minimax-code'),
        ...(process.platform === 'win32' && (process.env.SystemRoot || process.env.SYSTEMROOT)
          ? [join((process.env.SystemRoot || process.env.SYSTEMROOT)!, 'System32')]
          : []),
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
  return !argument || /\s/.test(argument) ? `"${argument}"` : argument
}

async function resolveExecutable(
  command: string,
  id?: string,
  installRoots: readonly string[] = [],
  native?: NativeCodexEntries,
): Promise<DetectedCommand | undefined> {
  const owner = id ?? Object.keys(info).find((key) => info[key]?.command === command)
  for (const candidate of candidatePaths(command, owner, installRoots))
    if (await executableFile(candidate.path)) return candidate
  if (configuredPath(command)) return undefined
  if (owner === 'codex' && command === 'codex') {
    const discovered = native ?? (await nativeCodexEntries())
    if (!discovered.limited && discovered.entries.length === 1) return discovered.entries[0]
  }
  const resolved = await shellResolved(command, owner ?? command)
  if (resolved && (await executableFile(resolved)))
    return { path: resolved, detectedBy: 'shell-path' }
  return undefined
}

/** Resolve the same regular CLI file used by Settings, retaining explicit path selections. */
export async function executablePath(command: string, id?: string): Promise<string | undefined> {
  return (await resolveExecutable(command, id))?.path
}

/** Keep CLI diagnostics useful without copying credentials or complete remote URLs. */
export function harnessDiagnostic(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /((?:["']?[\w-]*(?:token|api[_-]?key|password|secret|authorization)[\w-]*["']?)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/https?:\/\/[^\s]+/g, '[链接]')
    .trim()
    .slice(-1800)
}

export interface HarnessInspectionOptions {
  /** Bypass version caches after an install/update or an explicit verification request. */
  fresh?: boolean
  /** Directories returned by the actual installer, in addition to the desktop PATH. */
  installRoots?: readonly string[]
  /** Maximum time for one noninteractive version process. */
  versionTimeoutMs?: number
}

type VersionProbe = { version: string; error?: never } | { version?: never; error: string }
const versionCache = new Map<string, { expires: number; result: Promise<VersionProbe> }>()

/** Extract a CLI version line, excluding warnings, login prompts and arbitrary successful output. */
export function harnessVersion(
  output: string,
  harness: Pick<HarnessDefinition, 'id' | 'name'>,
): string | undefined {
  const entry = info[harness.id]
  const command = entry?.command
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(?:cmd|exe|bat)$/i, '')
  const names = [harness.id, harness.name, command, command && `${command}-cli`]
    .filter((name): name is string => !!name)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const number = 'v?\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?'
  const plain = new RegExp(`^${number}(?:\\s+\\([^\\r\\n]*\\))?$`, 'i')
  const labelled = new RegExp(
    `^((?:${names.join('|')})(?:\\.exe)?(?:\\s+CLI)?(?:,?\\s+(?:version\\s*)?|\\s*:\\s*)${number})(?:\\s+.*)?$`,
    'i',
  )
  const line = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => plain.test(line) || labelled.test(line))
  return line ? harnessDiagnostic(labelled.exec(line)?.[1] ?? line).slice(0, 150) : undefined
}

function versionEnvironment(path: string): NodeJS.ProcessEnv {
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
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  )
  return {
    ...env,
    PATH: [dirname(path), harnessSearchPath()].join(delimiter),
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  }
}

async function probeVersion(
  path: string,
  harness: HarnessDefinition,
  options: HarnessInspectionOptions,
): Promise<VersionProbe> {
  const timeout =
    options.versionTimeoutMs ??
    (['codex', 'claude', 'grok-build'].includes(harness.id) ? 15000 : 30000)
  const env = versionEnvironment(path)
  const details = await stat(path).catch(() => undefined)
  const prefixFiles = await Promise.all(
    (harness.prefix ?? []).filter(configuredPath).map(async (argument) => {
      const file = await stat(argument).catch(() => undefined)
      return [argument, file?.mtimeMs, file?.ctimeMs, file?.size, file?.ino]
    }),
  )
  const key = JSON.stringify([
    path,
    harness.id,
    harness.name,
    harness.prefix,
    timeout,
    env,
    details?.mtimeMs,
    details?.ctimeMs,
    details?.size,
    details?.ino,
    prefixFiles,
  ])
  const cached = versionCache.get(key)
  if (!options.fresh && cached && cached.expires > Date.now()) return cached.result
  const result = (async (): Promise<VersionProbe> => {
    try {
      const launch = commandLaunch(path, [...(harness.prefix ?? []), '--version'])
      const pending = exec(launch.command, launch.args, {
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        timeout,
        maxBuffer: 16384,
        env,
        windowsHide: true,
      })
      pending.child.stdin?.end()
      const { stdout, stderr } = await pending
      const version = harnessVersion(stdout + '\n' + stderr, harness)
      return version
        ? { version }
        : {
            error: `版本验证失败：${path} 未返回可识别的版本号（退出码 0）。请在终端使用同一路径执行 --version，确认该入口是 CLI 而非登录或桌面启动器后重新检测。`,
          }
    } catch (error) {
      const detail = error as {
        code?: string | number
        stdout?: string
        stderr?: string
        killed?: boolean
        message?: string
      }
      const output =
        harnessDiagnostic((detail.stderr ?? '') + '\n' + (detail.stdout ?? '')) ||
        harnessDiagnostic(detail.message ?? '')
      const reason = detail.killed
        ? `超过 ${timeout / 1000} 秒仍未退出`
        : typeof detail.code === 'number'
          ? `退出码 ${detail.code}`
          : `启动失败${detail.code ? ` ${detail.code}` : ''}`
      return {
        error: `版本验证失败：${path}（${reason}）。${output ? `${output}\n` : ''}请检查此启动入口及其运行依赖，并在终端使用同一路径执行 --version 后重新检测。`,
      }
    }
  })()
  versionCache.set(key, { expires: Date.now() + 60000, result })
  while (versionCache.size > 64) versionCache.delete(versionCache.keys().next().value!)
  return result
}

export async function inspectHarness(
  harness: HarnessDefinition,
  home: string,
  grokCommand?: string,
  options: HarnessInspectionOptions = {},
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
      verification: 'verified',
      version: process.env.OPL_OFFICIAL_VERSION ?? receipt.officialVersion ?? '由官方桌面提供',
      instructions: '内置于官方桌面，使用桌面的检查更新。',
      website: 'https://github.com/deepseek-ai/deepseek-harness/releases',
    }
  }
  const entry = info[harness.id],
    command =
      harness.command ?? (harness.kind === 'grok-build' ? grokCommand : undefined) ?? entry?.command
  const native: NativeCodexEntries =
    harness.id === 'codex' && !harness.codexRuntime ? await nativeCodexEntries() : { entries: [] }
  const found = command
    ? await resolveExecutable(command, harness.id, options.installRoots, native)
    : undefined
  const { path, detectedBy } = found ?? {}
  const otherPaths = native.entries.map((item) => item.path).filter((other) => other !== path)
  if (
    process.platform === 'win32' &&
    harness.id === 'codex' &&
    !harness.codexRuntime &&
    command &&
    command !== entry?.command
  ) {
    const official = await resolveExecutable('codex', 'codex', options.installRoots, native)
    if (official && official.path !== path && !otherPaths.includes(official.path))
      otherPaths.unshift(official.path)
  }
  const selectionRequired =
    !path && command === 'codex' && (native.entries.length > 1 || native.limited)
  const maintenanceAction = selectionRequired
    ? undefined
    : entry?.installable
      ? path
        ? 'update'
        : 'install'
      : path && ['grok-build', 'antigravity'].includes(harness.id)
        ? 'update'
        : undefined
  const supported =
    harness.kind === 'grok-build' ||
    (Object.hasOwn(info, harness.id) && harness.id !== 'antigravity')
  const base = {
    id: harness.id,
    name: harness.name,
    installed: !!path || (!!selectionRequired && native.entries.length > 0),
    runnable: false,
    instructions: entry?.instructions ?? '使用此 Harness 的官方安装与更新方式。',
    website: entry?.website ?? '',
    ...(entry?.installable ? { installable: true } : {}),
    ...(maintenanceAction ? { maintenanceAction: maintenanceAction as 'install' | 'update' } : {}),
    ...(otherPaths.length || native.limited
      ? { discovery: { otherPaths, ...(native.limited ? { limited: true } : {}) } }
      : {}),
  }
  if (!path)
    return {
      ...base,
      verification: 'failed',
      error:
        command && configuredPath(command)
          ? `配置的启动入口不存在或不是可执行文件：${command}。安装后仍需确认此路径。`
          : selectionRequired
            ? 'Codex 桌面安装目录中有多个入口或搜索达到上限，请在“可执行文件路径”中确认要使用的 codex.exe 绝对路径后重新检测。'
            : '未找到可执行文件；可使用一键安装或查看官方入口',
    }
  // ZCode's launcher is a desktop entry point on some installations. Running
  // `zcode --version` during settings discovery can briefly open its window.
  // Presence is enough for the settings card; version discovery belongs to the
  // official CLI and must never make opening Settings visible.
  const location = { path, ...(detectedBy ? { detectedBy } : {}) }
  if (harness.id === 'zcode')
    return { ...base, ...location, runnable: supported, verification: 'not-probed' }
  const probe = await probeVersion(path, harness, options)
  return {
    ...base,
    ...location,
    ...probe,
    runnable: !probe.error && supported,
    verification: probe.version ? 'verified' : 'failed',
  }
}

/** Verify the active selection after maintenance and report a separate installation without switching it. */
export async function inspectInstalledHarness(
  harness: HarnessDefinition,
  home: string,
  installation: { installRoots?: readonly string[] },
  grokCommand?: string,
): Promise<HarnessInstallation> {
  const options = {
    fresh: true,
    ...(installation.installRoots ? { installRoots: installation.installRoots } : {}),
  }
  const selected = await inspectHarness(harness, home, grokCommand, options)
  const entry = info[harness.id]
  if (!entry || harness.codexRuntime) return selected
  let target: DetectedCommand | undefined
  if (installation.installRoots) {
    for (const root of installation.installRoots) {
      for (const name of commandNames(entry.command)) {
        const path = resolve(root, name)
        if (await executableFile(path)) {
          target = { path, detectedBy: 'known-path' }
          break
        }
      }
      if (target) break
    }
    if (!target)
      return {
        ...selected,
        runnable: false,
        verification: 'failed',
        error: `官方安装器已结束，但在实际安装目录 ${installation.installRoots.join('、')} 未找到 ${entry.command} 启动入口。`,
      }
  } else if (
    selected.verification !== 'verified' &&
    harness.command &&
    configuredPath(harness.command)
  ) {
    target = await resolveExecutable(entry.command, harness.id)
  }
  if (!target || target.path === selected.path) return selected
  const candidate = await inspectHarness(
    { id: harness.id, name: harness.name, kind: harness.kind, command: target.path },
    home,
    grokCommand,
    { fresh: true },
  )
  const error =
    candidate.verification === 'verified'
      ? `官方安装入口位于 ${target.path}，当前配置仍指向 ${harness.command ?? selected.path ?? entry.command}。请在“可执行文件路径”中确认新入口后重新检测。`
      : `官方安装入口 ${target.path} 未通过版本验证：${candidate.error ?? '未返回版本号'}`
  return {
    ...selected,
    runnable: false,
    verification: 'failed',
    error,
    installedCandidate: {
      path: target.path,
      ...(candidate.version ? { version: candidate.version } : {}),
      verification: candidate.verification ?? 'failed',
      ...(candidate.error ? { error: candidate.error } : {}),
    },
  }
}
