/**
 * 候选构建与验证脚本共用的事实、摘要校验、命令执行和写入边界。
 *
 * 这里是唯一的写入闸门：所有输出都必须落在调用方声明的独占目录内，且与官方安装目录、
 * 官方登录目录和 OPL profile 在任意方向上都不重叠。所有外部命令都按 argv 数组调用，
 * Windows 的 `.cmd`/`.bat` shim 走 cmd.exe 并逐字传参，因此带空格的路径按原样传递。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import candidatePlan from './candidate.json' with { type: 'json' }

export const scriptDir = fileURLToPath(new URL('.', import.meta.url))
export const plan = candidatePlan

/**
 * 拒绝写入的目录：官方启动器目录、官方登录/数据目录、OPL profile 与套件 Harness 目录。
 * `~/.dsh` 是安装器使用的 profile home（`OPL_DSH_HOME` 可覆盖），
 * `%APPDATA%/OPL DSH Suite` 是套件自有的 Harness 根目录，候选版的安装由安装器负责。
 *
 * 官方 mcode 可以装在任意位置（npm 全局、PATH 上的自定义目录、用户自己指定的目录），
 * 只靠固定路径无法覆盖。这里只做两件不接触用户数据的事：按 PATH/PATHEXT 解析官方命令
 * 并把它的**所在目录**纳入保护；对无法自动判定的自定义安装位置，要求用户显式声明
 * （环境变量 `OPL_MCODE_PROTECTED_ROOTS`，逗号分隔）。不读取任何文件内容，不遍历目录。
 */
export function officialProtectedRoots(env = process.env, extraRoots = []) {
  const home = env.USERPROFILE || env.HOME || homedir()
  const roots = [
    join(home, '.minimax-code'),
    join(home, '.minimax'),
    join(home, '.minimax-code-data'),
    join(home, '.config', 'mcode'),
    env.OPL_DSH_HOME?.trim() || join(home, '.dsh'),
    join(tmpdir(), 'mcode-official-probe'),
  ]
  for (const value of [env.MINIMAX_CODE_HOME, env.MINIMAX_DATA_DIR, env.MAVIS_DATA_DIR]) {
    if (value?.trim()) roots.push(resolve(value.trim()))
  }
  for (const value of (env.OPL_MCODE_PROTECTED_ROOTS ?? '').split(/[;,]/)) {
    if (value.trim()) roots.push(resolve(value.trim()))
  }
  for (const value of extraRoots) if (value) roots.push(resolve(value))
  // 官方启动器实际所在目录：只判断存在性，不读取内容。
  const official = resolveCommandPath(process.platform === 'win32' ? 'mcode.cmd' : 'mcode', env)
  if (official) roots.push(dirname(resolve(official)))
  return normalizeRoots(roots)
}

/**
 * 套件自有的 Harness 根目录。构建脚本一律把它当受保护目录，避免构建结果写进已安装的套件；
 * 只有显式声明的生命周期操作（候选导入/选择）才在自己的 Store 里写，见 lifecycle.mjs。
 */
export function suiteOwnedRoots(env = process.env) {
  return normalizeRoots([
    env.APPDATA ? join(env.APPDATA, 'OPL DSH Suite') : '',
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'OPL DSH Suite') : '',
  ])
}

export function protectedRoots(env = process.env, extraRoots = []) {
  return [...new Set([...officialProtectedRoots(env, extraRoots), ...suiteOwnedRoots(env)])]
}

function normalizeRoots(roots) {
  return [...new Set(roots.filter(Boolean).map((value) => resolveThroughExistingAncestors(value)))]
}

/** 两个绝对路径在任意方向重叠（相等、互为祖先或互为后代）时为 true。 */
export function overlapsPath(left, right) {
  return overlaps(resolve(left), resolve(right))
}

/** target 落在 base 之内（含相等）时为 true。 */
export function containsPath(base, target) {
  const span = relative(resolve(base), resolve(target))
  return span === '' || (!span.startsWith(`..${sep}`) && span !== '..' && !isAbsolute(span))
}

/**
 * 把可能还不存在的路径解析成真实路径：向上找到最近的存在祖先，对它取 realpath，
 * 再拼回剩余片段。首次创建时 realpath 会失败——此时必须报错而不是退回绝对路径，
 * 否则已有 symlink/junction 祖先（以及断链）会被当成安全路径放行。
 */
export function resolveThroughExistingAncestors(path) {
  const absolute = resolve(path)
  const segments = []
  let current = absolute
  while (true) {
    try {
      lstatSync(current)
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current)
      throw new Error(`无法为 ${absolute} 找到可规范化的现存祖先，拒绝按未验证路径处理。`)
    segments.unshift(basename(current))
    current = parent
  }
  let real
  try {
    real = resolve(realpathSync(current))
  } catch (error) {
    throw new Error(
      `无法解析现存祖先 ${current} 的真实路径（${error.code ?? error.message}），拒绝放行。`,
    )
  }
  return segments.length ? resolve(real, ...segments) : real
}

/** 两个路径在任意方向上重叠即为冲突：相等、互为祖先或互为后代。 */
function overlaps(left, right) {
  const span = relative(left, right)
  const contained =
    span === '' || (!span.startsWith(`..${sep}`) && span !== '..' && !isAbsolute(span))
  const reverse = relative(right, left)
  const contains =
    reverse === '' || (!reverse.startsWith(`..${sep}`) && reverse !== '..' && !isAbsolute(reverse))
  return contained || contains
}

/** 候选版允许出现在独占目录里；与受保护目录双向重叠一律拒绝，没有覆盖开关。 */
export function assertNotProtected(target, env = process.env, label = '输出', extraRoots = []) {
  const inside = resolveThroughExistingAncestors(target)
  for (const root of protectedRoots(env, extraRoots)) {
    if (overlaps(root, inside))
      throw new Error(
        `${label} ${inside} 与受保护目录 ${root}（官方安装、官方登录数据或 OPL profile）重叠，拒绝写入。`,
      )
  }
  return inside
}

/** 写入前的统一闸门：绝对路径、不与受保护目录重叠、位于声明的独占根之内。 */
export function assertWritableTarget(target, { root, label = '输出', extraRoots = [] } = {}) {
  if (!isAbsolute(target)) throw new Error(`${label}必须是绝对路径，收到 ${target}。`)
  // 先验证真实目标，再谈创建：拒绝时不能留下目录。
  const inside = assertNotProtected(target, process.env, label, extraRoots)
  if (root) {
    const base = resolveThroughExistingAncestors(root)
    const span = relative(base, inside)
    if (span.startsWith(`..${sep}`) || span === '..' || isAbsolute(span))
      throw new Error(`${label} ${inside} 不在独占目录 ${base} 内，拒绝写入。`)
  }
  return inside
}

/** 候选版本号必须显式、带候选后缀，并且以复核过的官方版本为前缀。 */
export function assertCandidateVersion(version) {
  const supported = [plan.official.version, '0.7.4']
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+-opl-bash\.\d{8}\.\d+$/.test(version))
    throw new Error(
      `候选版本号必须是 <官方版本>-opl-bash.<YYYYMMDD>.<序号>，收到 ${JSON.stringify(version)}。`,
    )
  if (!supported.some((official) => version.startsWith(`${official}-opl-bash.`)))
    throw new Error(`候选版本号必须以已复核官方版本 ${supported.join('/')} 开头，拒绝 ${version}。`)
  return version
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha512Base64(bytes) {
  return createHash('sha512').update(bytes).digest('base64')
}

export function sha256File(path) {
  return sha256(readFileSync(path))
}

/** 校验补丁或归档的固定摘要，不匹配即失败，不做任何降级或修补。 */
export function assertDigest(path, expected, label) {
  const actual = sha256File(path)
  if (actual !== expected)
    throw new Error(`${label} 摘要不匹配：期望 ${expected}，实际 ${actual}（${path}）。`)
  return actual
}

export function mkdirp(path) {
  mkdirSync(path, { recursive: true })
  return path
}

export function writeJson(path, value) {
  mkdirp(resolve(path, '..'))
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

/** 逐行 JSONL 构建轨迹，供主审核对真实执行过哪些步骤。 */
export function createTrace(path) {
  mkdirp(resolve(path, '..'))
  return {
    path,
    record(event, detail = {}) {
      appendFileSync(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`,
        'utf8',
      )
    },
  }
}

/** 在 PATH 与 PATHEXT 中解析真实可执行文件，返回 '' 表示没有找到。 */
export function resolveCommandPath(command, env = process.env) {
  if (!command) return ''
  if (isAbsolute(command) || command.includes('/') || command.includes('\\'))
    return existsSync(command) ? command : ''
  const extensions =
    process.platform === 'win32'
      ? extname(command)
        ? ['']
        : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  const roots = (env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const root of roots) {
    for (const extension of extensions) {
      const candidate = join(root, command + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return existsSync(command) ? command : ''
}

/**
 * Windows 上 `.cmd`/`.bat` 不是可执行映像，必须经 cmd.exe 启动；`cmd /S` 只剥最外层引号，
 * 因此脚本路径要留在第二层引号里，并且整个参数向量必须逐字送达 cmd。含空格的路径
 * （Program Files 下的常规情形）依赖这一点。
 */
export function commandLaunch(command, args = [], env = process.env) {
  const resolved = resolveCommandPath(command, env)
  if (!resolved || process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(resolved))
    return { command: resolved || command, args: [...args], resolved }
  for (const argument of args)
    if (/["%^&|<>()\r\n]/.test(argument))
      throw new Error(`无法安全地通过 cmd.exe 传递参数：${argument}`)
  const line = [
    `"${resolved}"`,
    ...args.map((value) => (/\s/.test(value) ? `"${value}"` : value)),
  ].join(' ')
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
    resolved,
  }
}

/**
 * 执行外部命令并把命令、退出码和输出记进轨迹。命令一律用参数数组调用；
 * 默认只把输出尾部写进轨迹，避免把环境内容带出去。
 */
export function run(argv, { cwd, trace, capture = true, env } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string')
    throw new Error(`run 需要非空 argv 数组，收到 ${JSON.stringify(argv)}。`)
  // 命令解析必须用调用方给的环境：自定义 PATH 下的 .cmd shim 也要能被找到。
  const launch = commandLaunch(argv[0], argv.slice(1), env ?? process.env)
  const started = Date.now()
  let result
  try {
    result = execFileSync(launch.command, launch.args, {
      cwd,
      env: env ?? process.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
    })
  } catch (error) {
    trace?.record('command', {
      command: argv,
      resolved: launch.resolved,
      cwd,
      exitCode: error.status ?? null,
      ms: Date.now() - started,
      stderr: tail(error.stderr),
    })
    throw new Error(
      `命令失败（${error.status ?? 'signal'}）：${argv.join(' ')}\n${tail(error.stderr)}`,
    )
  }
  trace?.record('command', {
    command: argv,
    resolved: launch.resolved,
    cwd,
    exitCode: 0,
    ms: Date.now() - started,
    stdout: tail(result),
  })
  return result
}

function tail(value, limit = 2000) {
  if (typeof value !== 'string' || !value) return ''
  return value.length > limit ? `${value.slice(-limit)}…` : value
}

/**
 * 下载归档并校验固定摘要；只写入声明的下载目录，不启用任何 TLS 例外。
 * expectation 可以是 { sha256 }（源码归档）或 { integritySha512 }（官方 npm 归档）。
 * 两种摘要语义不同，见 candidate.json 的说明，脚本按声明的字段校验，不互相替代。
 */
export async function downloadVerified(url, destination, expectation, trace, label) {
  mkdirp(resolve(destination, '..'))
  trace?.record('download', { url, destination, expectation })
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`下载 ${label} 失败：HTTP ${response.status} ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const observed = {
    bytes: bytes.length,
    sha256: sha256(bytes),
    integritySha512: sha512Base64(bytes),
  }
  for (const field of ['sha256', 'integritySha512']) {
    const expected = expectation[field]
    if (!expected) continue
    if (observed[field] !== expected)
      throw new Error(
        `${label} ${field} 不匹配：期望 ${expected}，实际 ${observed[field]}（${url}）。`,
      )
  }
  writeFileSync(destination, bytes)
  trace?.record('download-verified', { url, ...observed })
  return observed
}

/** 归档条目的路径预检：拒绝绝对路径、盘符和上跳，防止解包越界。 */
export function assertSafeArchiveEntries(entries) {
  const unsafe = entries.filter((entry) => {
    const name = entry.replaceAll('\\', '/')
    return (
      name.startsWith('/') ||
      /^[a-zA-Z]:/.test(name) ||
      name.split('/').includes('..') ||
      name.includes('\0')
    )
  })
  if (unsafe.length)
    throw new Error(`归档包含不安全条目，拒绝解包：${unsafe.slice(0, 3).join(', ')}`)
  return entries.length
}

/** 清单里的文件键必须是相对路径且不能逃逸候选目录。 */
export function assertRelativeInside(file, label = '清单条目') {
  if (typeof file !== 'string' || !file || isAbsolute(file) || /^[a-zA-Z]:/.test(file))
    throw new Error(`${label}必须是相对路径，收到 ${JSON.stringify(file)}。`)
  const normalized = file.replaceAll('\\', '/')
  if (normalized.split('/').includes('..')) throw new Error(`${label} ${file} 逃出候选目录，拒绝。`)
  return normalized
}

export function tarVersion(trace) {
  return toolVersion('tar', ['--version'], trace)
}

export function toolVersion(command, args, trace) {
  try {
    return run([command, ...args], { trace })
      .split('\n')[0]
      .trim()
  } catch {
    return 'unavailable'
  }
}

export { extname }
