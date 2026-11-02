#!/usr/bin/env node
/**
 * MiniMax Bash 候选版的生命周期：可校验导入、版本目录、显式选择、升级与切回官方。
 *
 * 这个脚本不重造安装体系。它复用既有约定的两样东西：
 *   1) 套件自有的 Harness 根目录布局 `<套件根>/harnesses/MiniMax Code/<候选版本>/`
 *      （与 src/execution/host/adapters 的 harness home 同一位置约定，见安装回执里的
 *      `installation.candidate`）；
 *   2) `pipeline.mjs` 的清单/许可/能力/凭据原语，与构建和验证脚本用的是同一份实现。
 *
 * 它明确不做的事：
 *   - 不联网、不下载 latest、不自动更新；没有任何参数能让它去取远端内容。
 *   - 不读取、不复制官方登录目录与账号数据；只对候选目录做文件名级凭据扫描。
 *   - 不写系统 PATH，不改官方 `mcode` 安装；官方安装目录与账号目录一律拒写。
 *   - 不读官方 Desktop 的 `execution-catalog.json` 或任何 `*.control.json`。当前选择由本
 *     脚本自己的选择回执 `selection.json`（套件自有位置）记录；“活动任务数”必须由调用方
 *     通过 `--active-tasks` / `--activity` 注入公开状态，本脚本不自行探活。
 *   - 不执行候选代码。导入前的校验只读目录、只算摘要。
 *
 * 失败语义：任何一步失败都保持原样。选择回执只在全部检查通过后用临时文件 + rename 原子
 * 替换；导入失败留下的半成品会被改名成 `<版本>.failed-<时间戳>` 保留，不会被选择。
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { distribution, verifyOfficialDistribution } from './distribution.mjs'
import {
  assertCandidateVersion,
  assertRelativeInside,
  containsPath,
  mkdirp,
  officialProtectedRoots,
  overlapsPath,
  plan,
  resolveCommandPath,
  resolveThroughExistingAncestors,
  sha256File,
  suiteOwnedRoots,
} from './shared.mjs'
import {
  candidateFiles,
  detectCapabilities,
  launcherContent,
  licenseTargets,
  scanForCredentials,
  verifyExternalModuleClosure,
} from './pipeline.mjs'

export const LIFECYCLE_SCHEMA_VERSION = 1
/** 候选在套件 Harness 根目录里的 harnessRef，与安装回执 installation.candidate 一致。 */
export const HARNESS_REF = 'MiniMax Code'
export const SELECTION_FILE = 'selection.json'
export const VERIFICATION_DIR = 'verification'
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-opl-bash\.(\d{8})\.(\d+)$/
/** 本模块从不联网；这个常量进计划与回执，供他人核对。 */
export const NETWORK_ACCESS = false

const required = (value, flag) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`必须提供 ${flag}。`)
  return value
}

// ---------------------------------------------------------------- 位置与边界

/** 允许写候选的根目录：套件自有 Harness 根 + 调用方显式声明的 `--allow-root`。 */
export function allowedStoreRoots(env = process.env, allowRoots = []) {
  return [
    ...new Set([
      ...suiteOwnedRoots(env),
      ...allowRoots.filter(Boolean).map((value) => resolveThroughExistingAncestors(value)),
    ]),
  ]
}

export function defaultStoreRoot(env = process.env) {
  const suites = suiteOwnedRoots(env)
  if (!suites.length)
    throw new Error(
      '无法确定套件根目录（环境里没有 APPDATA/LOCALAPPDATA）；请显式给出 --store 与 --allow-root。',
    )
  return join(suites[0], 'harnesses', HARNESS_REF)
}

/**
 * 候选 Store 根目录的写入闸门。和构建脚本不同，这里允许写套件自有的 Harness 根目录
 * （这正是导入的目的），但官方安装目录、官方登录数据与 OPL profile 仍然一律拒写；
 * 套件根之外的位置必须由调用方用 `--allow-root` 显式声明。
 */
export function assertStoreRoot(
  storeRoot,
  { env = process.env, allowRoots = [], extraRoots = [], label = '候选 Store 根目录' } = {},
) {
  const inside = resolveThroughExistingAncestors(required(storeRoot, '--store <目录>'))
  if (!isAbsolute(inside)) throw new Error(`${label}必须是绝对路径，收到 ${storeRoot}。`)
  for (const forbidden of officialProtectedRoots(env, extraRoots))
    if (overlapsPath(forbidden, inside))
      throw new Error(
        `${label} ${inside} 与官方安装、官方登录数据或 OPL profile ${forbidden} 重叠，拒绝写入。`,
      )
  const allowed = allowedStoreRoots(env, allowRoots)
  if (!allowed.some((base) => containsPath(base, inside)))
    throw new Error(`${label} ${inside} 不在套件自有根目录内；请用 --allow-root 显式声明这个位置。`)
  return inside
}

export function selectionPath(storeRoot) {
  return join(storeRoot, SELECTION_FILE)
}
export function versionDir(storeRoot, version) {
  return join(storeRoot, version)
}
export function verificationDir(storeRoot, version) {
  return join(storeRoot, VERIFICATION_DIR, version)
}

/**
 * 派生输出的统一写入闸门。`assertStoreRoot` 只证明 **Store 根目录**落在套件自有位置；
 * 候选目录、`verification/` 报告目录、`selection.json` 与暂存/改名目录都是**派生**路径，
 * 它们的**现存祖先**可能是符号链接/junction（例如 `<store>/verification` 被指向 Store 之外）。
 * 因此每个派生目标都要按真实路径规范化后重新判定：必须仍在同一个 Store 内，
 * 且不得与官方安装、官方登录数据或 OPL profile 重叠。任一不符都在写入之前拒绝。
 */
export function assertDerivedTarget(
  target,
  { storeRoot, env = process.env, extraRoots = [], label = '派生输出' } = {},
) {
  if (typeof target !== 'string' || !isAbsolute(target))
    throw new Error(`${label}必须是绝对路径，收到 ${JSON.stringify(target)}。`)
  const store = resolveThroughExistingAncestors(storeRoot)
  const inside = resolveThroughExistingAncestors(target)
  if (!containsPath(store, inside))
    throw new Error(
      `${label} ${inside} 不在候选 Store ${store} 内（可能是符号链接/junction 指向外部），拒绝写入。`,
    )
  for (const forbidden of officialProtectedRoots(env, extraRoots))
    if (overlapsPath(forbidden, inside))
      throw new Error(`${label} ${inside} 与受保护目录 ${forbidden} 重叠，拒绝写入。`)
  return inside
}

/** 先把 Store 内将要写到的每个派生路径全部验证一遍，再开始任何写入。 */
function assertDerivedTargets(storeRoot, targets, { env, extraRoots = [] }) {
  return targets.map(({ path, label }) =>
    assertDerivedTarget(path, { storeRoot, env, extraRoots, label }),
  )
}

/** 只读列出 Store 里的候选版本目录；`verification/` 与改名保留的目录不算候选。 */
export function listImportedVersions(storeRoot) {
  if (!existsSync(storeRoot)) return []
  return readdirSync(storeRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory() && VERSION_PATTERN.test(item.name))
    .map((item) => item.name)
    .sort(compareVersions)
}

/** `0.6.3-opl-bash.20261010.2` 之类的候选版本号比较：官方段、日期、序号依次比较。 */
export function compareVersions(left, right) {
  const a = VERSION_PATTERN.exec(String(left ?? ''))
  const b = VERSION_PATTERN.exec(String(right ?? ''))
  if (!a || !b) throw new Error(`无法比较候选版本号：${left} 与 ${right}。`)
  for (let index = 1; index <= 5; index += 1) {
    const diff = Number(a[index]) - Number(b[index])
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

// ---------------------------------------------------------------- 选择回执

/**
 * 读取选择回执。文件不存在返回 undefined；存在但损坏或版本不符则报错，
 * 绝不把无法理解的回执当成空回执覆盖。
 */
export function readSelection(storeRoot) {
  const path = selectionPath(storeRoot)
  if (!existsSync(path)) return undefined
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`选择回执已损坏，拒绝覆盖：${path}（${error.message}）`)
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== LIFECYCLE_SCHEMA_VERSION)
    throw new Error(`选择回执 schemaVersion 不受支持，拒绝覆盖：${path}`)
  if (!parsed.selection || !['candidate', 'official'].includes(parsed.selection.kind))
    throw new Error(`选择回执缺少有效的 selection.kind，拒绝覆盖：${path}`)
  return parsed
}

/** 原子写选择回执：临时文件 + rename；失败不会留下半份回执。 */
function writeSelection(storeRoot, receipt, { env = process.env, extraRoots = [] } = {}) {
  const target = selectionPath(storeRoot)
  return writeJsonAtomically(storeRoot, target, receipt, { env, extraRoots })
}

/** 回执和报告均创建独占临时文件后替换目录项，不改写现存硬链接所引用的文件。 */
function writeJsonAtomically(storeRoot, target, value, { env, extraRoots }) {
  const temporary = `${target}.${randomUUID()}.tmp`
  // 回执文件与它的临时文件都是派生路径：现存祖先可能是 junction，写入前必须重新判定。
  assertDerivedTargets(
    storeRoot,
    [
      { path: temporary, label: '回执临时文件' },
      { path: target, label: '选择回执' },
    ],
    { env, extraRoots },
  )
  mkdirp(dirname(temporary))
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  try {
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      /* 保留原错误 */
    }
    throw error
  }
  return target
}

/**
 * 生成新的选择回执。`preserved` 是不透明状态，原样搬运，因此代理、模型、权限等
 * 调用方设置不会因为一次导入/升级/切回而被改写；`candidates` 由一个只读扫描得出，
 * 旧候选目录既不删除也不从列表里消失。
 */
export function buildReceipt({
  storeRoot,
  previous,
  selection,
  official,
  now = new Date().toISOString(),
}) {
  const history = previous?.history ? [...previous.history] : []
  if (
    previous?.selection &&
    (previous.selection.kind !== selection.kind ||
      previous.selection.version !== selection.version ||
      previous.selection.launcher !== selection.launcher)
  )
    history.push({ ...previous.selection, at: previous.updatedAt ?? null })
  const known = new Map((previous?.candidates ?? []).map((item) => [item.version, item]))
  const candidates = listImportedVersions(storeRoot).map((version) => {
    const entry = known.get(version) ?? {}
    const launcher = join(versionDir(storeRoot, version), plan.launcher.windows)
    return {
      version,
      launcher: existsSync(launcher) ? launcher : null,
      launcherSha256: existsSync(launcher) ? sha256File(launcher) : null,
      manifestSha256: entry.manifestSha256 ?? null,
      importedAt: entry.importedAt ?? null,
      verified: entry.verified ?? false,
    }
  })
  return {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    harnessRef: HARNESS_REF,
    storeRoot,
    updatedAt: now,
    selection,
    official,
    preserved: previous?.preserved ?? {},
    history: history.slice(-50),
    candidates,
  }
}

// ---------------------------------------------------------------- 候选校验

function resolveManifestPath(sourceDir, manifestPath) {
  if (manifestPath) {
    const explicit = resolve(manifestPath)
    if (!existsSync(explicit)) throw new Error(`清单不存在：${explicit}`)
    return explicit
  }
  for (const candidate of [
    join(sourceDir, 'manifest.json'),
    join(dirname(sourceDir), 'candidate-manifest.json'),
  ])
    if (existsSync(candidate)) return candidate
  throw new Error(`未找到清单：${sourceDir} 内没有 manifest.json，也没有 --manifest。`)
}

/** 候选目录里不允许出现符号链接：导入不能把官方安装或账号目录链接进来。 */
function collectSymlinks(directory, found = [], current = directory) {
  for (const item of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, item.name)
    if (item.isSymbolicLink()) {
      found.push(path)
      continue
    }
    if (item.isDirectory()) collectSymlinks(directory, found, path)
  }
  return found
}

/** 扫描 bundle 里声明的标记串：bundle 缺失或标记缺失都按失败暴露。 */
function scanBundleMarkers(candidateDir, markers) {
  const files = []
  const walk = (current) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, item.name)
      if (item.isDirectory()) walk(path)
      else if (item.isFile() && /\.m?js$/.test(item.name)) files.push(path)
    }
  }
  for (const name of ['chunks', 'overlay']) {
    const root = join(candidateDir, name)
    if (existsSync(root)) walk(root)
  }
  const haystack = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  return {
    scanned: files.length > 0,
    missing: markers.filter((marker) => !haystack.includes(marker)),
  }
}

/**
 * 启动器必须是**完整的已知模板**，而不是「包含若干合法子串」。
 *
 * `launcherContent()` 产出的模板只有运行时那一行会变；此外任何一行新增、删除、改写
 * （例如在启动前插入 `echo unexpected-action`、追加重定向或 `&` 连接命令）都必须拒绝。
 * 只扫描被引用的 `%~dp0` 路径无法发现这类注入——实测中带额外命令的启动器会被接受。
 */
function launcherGrammarCheck(actualLauncher) {
  const template = launcherContent(undefined).split('\r\n')
  const normalized = String(actualLauncher).replaceAll('\r\n', '\n')
  const lines = normalized.split('\n')
  if (lines.length !== template.length)
    return {
      ok: false,
      runtime: null,
      detail: `启动器行数 ${lines.length} ≠ 模板 ${template.length} 行，只允许运行时那一行变化`,
    }
  const runtimeLineIndex = template.findIndex((line) => line.includes('"%~dp0cli.js" %*'))
  for (let index = 0; index < template.length; index += 1) {
    if (index === runtimeLineIndex) continue
    if (lines[index] !== template[index])
      return {
        ok: false,
        runtime: null,
        detail: `启动器第 ${index + 1} 行与已知模板不符：${JSON.stringify(lines[index])}`,
      }
  }
  const match = /^(.+?) "%~dp0cli\.js" %\*$/.exec(lines[runtimeLineIndex])
  if (!match)
    return {
      ok: false,
      runtime: null,
      detail: `运行时行不符合模板：${JSON.stringify(lines[runtimeLineIndex])}`,
    }
  const token = match[1]
  const allowedToken = token === 'node' || /^"(?:[A-Za-z]:[\\/][^"]*|%~dp0[^"]*)"$/.test(token)
  if (!allowedToken)
    return { ok: false, runtime: null, detail: `不允许的运行时写法：${JSON.stringify(token)}` }
  return { ok: true, runtime: token, detail: `已知模板，运行时行：${token}` }
}

/** 运行时 token → 清单里应声明的 `nodeRuntime.path`（`system-node` 表示 PATH 上的 node）。 */
function runtimeTokenToDeclared(token) {
  if (token === 'node') return 'system-node'
  const inner = token.slice(1, -1)
  return inner.startsWith('%~dp0') ? inner.slice('%~dp0'.length) : inner
}

/**
 * 运行时一致性：启动器引用的运行时必须与清单声明一致，或者是**候选目录内**的等价可携带形态
 * （例如自包含布局的 `"%~dp0node.exe"`）——后者必须存在、不上跳、且被清单摘要覆盖。
 * 清单声明指向候选外的绝对路径时也接受（构建产物形态），但绝不允许凭空出现未声明的运行时。
 */
function launcherRuntimeCheck(runtimeToken, { base, declared, declaredNode }) {
  if (!runtimeToken) return [false, '启动器语法未通过，运行时无法判定']
  const declaredValue = declaredNode ?? 'system-node'
  const declaredPath =
    typeof declaredValue === 'string' ? declaredValue.replaceAll('\\', '/') : declaredValue
  const tokenDeclared = runtimeTokenToDeclared(runtimeToken)
  const tokenPath = tokenDeclared.replaceAll('\\', '/')

  if (tokenDeclared === declaredPath) {
    if (tokenDeclared !== 'system-node' && !isAbsolute(tokenDeclared) && !declared.has(tokenPath))
      return [false, `启动器引用的运行时未被清单摘要覆盖：${tokenPath}`]
    return [true, `与清单声明的运行时一致：${declaredValue}`]
  }
  // 声明 system-node 却自带候选内运行时：允许，但该文件必须真实存在且被摘要覆盖。
  if (declaredPath === 'system-node' && tokenPath !== 'system-node') {
    if (isAbsolute(tokenDeclared))
      return [false, `清单声明 system-node，启动器却写死绝对运行时 ${tokenDeclared}；两者必须一致`]
    if (tokenPath.split('/').includes('..') || tokenPath.startsWith('/'))
      return [false, `启动器引用的运行时逃出候选目录：${tokenPath}`]
    if (!existsSync(join(base, ...tokenPath.split('/'))))
      return [false, `启动器引用的运行时不存在：${tokenPath}`]
    if (!declared.has(tokenPath)) return [false, `启动器引用的运行时未被清单摘要覆盖：${tokenPath}`]
    return [true, `候选内运行时已被清单覆盖：${tokenPath}`]
  }
  return [
    false,
    `启动器运行时 ${JSON.stringify(tokenDeclared)} 与清单声明 ${JSON.stringify(declaredValue)} 不一致`,
  ]
}

/**
 * 导入前的只读校验：版本、摘要、能力、许可证。不执行候选代码、不联网。
 * 返回的 `passed` 为 false 时调用方不得复制或选择；`checks` 逐项给出原因。
 */
export function verifyImportCandidate(
  sourceDir,
  { manifestPath, version, env = process.env, extraRoots = [] } = {},
) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 2000) })
    return !!ok
  }
  const base = resolve(sourceDir)
  check('source-present', existsSync(base) && statSync(base).isDirectory(), base)

  let officialOverlap = ''
  try {
    // 注入的 env 与进程环境都要查：调用方可以只覆盖其中一个。
    const forbiddenRoots = [
      ...officialProtectedRoots(env, extraRoots),
      ...officialProtectedRoots(process.env, extraRoots),
    ]
    for (const forbidden of forbiddenRoots)
      if (overlapsPath(forbidden, base)) officialOverlap = forbidden
  } catch (error) {
    officialOverlap = `无法规范化路径：${error.message}`
  }
  check('source-not-official-install', !officialOverlap, officialOverlap || '不在受保护目录内')

  let symlinks = []
  if (existsSync(base) && statSync(base).isDirectory()) {
    try {
      symlinks = collectSymlinks(base)
    } catch (error) {
      symlinks = [`无法遍历：${error.message}`]
    }
  }
  check(
    'source-no-symlinks',
    symlinks.length === 0,
    symlinks.length ? `发现符号链接：${symlinks.slice(0, 3).join(', ')}` : '无符号链接',
  )

  let manifestFile
  let manifest
  try {
    manifestFile = resolveManifestPath(base, manifestPath)
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    check('manifest-present', true, manifestFile)
  } catch (error) {
    check('manifest-present', false, error.message)
    return finish(checks, { version: null, manifestPath: null, base })
  }
  const manifestInside = manifestFile === base || manifestFile.startsWith(base + sep)
  const schemaOk =
    manifest &&
    typeof manifest.version === 'string' &&
    Array.isArray(manifest.files) &&
    manifest.files.every(
      (entry) =>
        entry &&
        typeof entry.file === 'string' &&
        typeof entry.sha256 === 'string' &&
        Number.isInteger(entry.bytes),
    )
  check('manifest-schema', schemaOk, schemaOk ? `${manifest.files.length} 个条目` : '清单结构无效')
  if (!schemaOk) return finish(checks, { version: null, manifestPath: manifestFile, base })

  // 同一条路径出现两次会让「覆盖所有文件」与摘要校验同时失真，直接拒绝。
  const duplicatePaths = [
    ...new Set(
      manifest.files
        .map((entry) => String(entry.file))
        .filter((file, index, all) => all.indexOf(file) !== index),
    ),
  ]
  check(
    'manifest-unique-paths',
    duplicatePaths.length === 0,
    duplicatePaths.length ? `重复条目：${duplicatePaths.slice(0, 3).join(', ')}` : '无重复条目',
  )

  const declaredVersion = manifest.version
  const npmOverlay = manifest.distribution === 'official-npm-overlay'
  const officialBase = npmOverlay ? distribution.official.version : plan.official.version
  const shapeOk = VERSION_PATTERN.test(declaredVersion)
  check('version-declared', shapeOk, declaredVersion)
  check(
    'version-matches-official-base',
    shapeOk && declaredVersion.startsWith(`${officialBase}-opl-bash.`),
    `官方基线 ${officialBase}`,
  )
  check(
    'version-requested-matches',
    !version || version === declaredVersion,
    version ? `请求 ${version}，清单 ${declaredVersion}` : '未额外指定',
  )
  let versionAccepted = false
  let versionRejection = '版本号格式或官方基线不符'
  if (shapeOk && declaredVersion.startsWith(`${officialBase}-opl-bash.`)) {
    try {
      assertCandidateVersion(declaredVersion)
      versionAccepted = true
      versionRejection = ''
    } catch (error) {
      versionRejection = error.message
    }
  }
  check(
    'version-accepted-by-plan',
    versionAccepted,
    versionAccepted ? declaredVersion : versionRejection,
  )

  const stubbed = manifest.toolchainStubbed === true
  check('toolchain-not-stubbed', !stubbed, stubbed ? '替身工具链产物，不可导入' : '真实工具链')
  if (npmOverlay) {
    try {
      const result = verifyOfficialDistribution(join(base, 'official'))
      check('official-npm-unchanged', true, `${result.version}: ${result.files} files`)
    } catch (error) {
      check('official-npm-unchanged', false, error.message)
    }
  }

  for (const requiredFile of ['cli.js', plan.launcher.windows, 'package.json', 'CANDIDATE.md'])
    check(
      `layout:${requiredFile}`,
      existsSync(join(base, requiredFile)),
      existsSync(join(base, requiredFile)) ? requiredFile : `缺少 ${requiredFile}`,
    )

  // 分布清单的身份必须自洽：目录里的 package.json 既要是官方构建链写出的分发名，
  // 也要把自己声明成清单里的那个候选版本。只看 manifest.version 字符串
  // 会让「改写 package.json、重算摘要、保留 manifest.version」的候选通过。
  let packageIdentity = ''
  let packageOk = false
  try {
    const manifestPackage = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
    const expectedName = plan.official.packageName
    const nameOk = manifestPackage.name === expectedName
    const versionOk = manifestPackage.version === declaredVersion
    packageOk = nameOk && versionOk
    packageIdentity = packageOk
      ? `${manifestPackage.name}@${manifestPackage.version}`
      : [
          nameOk
            ? ''
            : `包名 ${JSON.stringify(manifestPackage.name)} ≠ ${JSON.stringify(expectedName)}`,
          versionOk
            ? ''
            : `包版本 ${JSON.stringify(manifestPackage.version)} ≠ 清单版本 ${JSON.stringify(declaredVersion)}`,
        ]
          .filter(Boolean)
          .join('；')
  } catch (error) {
    packageIdentity = `package.json 无法解析：${error.message}`
  }
  check('candidate-package-identity', packageOk, packageIdentity)

  // 清单声明的文件集合（统一正斜杠）在这里就要用来核对启动器引用的运行时。
  const declared = new Set(manifest.files.map((entry) => assertRelativeInside(entry.file)))

  const declaredNode = manifest.nodeRuntime?.path
  const launcherPath = join(base, plan.launcher.windows)
  const actualLauncher = existsSync(launcherPath) ? readFileSync(launcherPath, 'utf8') : ''
  // 语法与运行时分开判定：语法必须是已知模板且只允许运行时一行变化，
  // 运行时那一行再单独核对「与清单声明一致」或「候选内且被摘要覆盖」。
  const grammar = launcherGrammarCheck(actualLauncher)
  check('launcher-grammar', grammar.ok, grammar.detail)
  check(
    'launcher-runtime-resolvable',
    ...launcherRuntimeCheck(grammar.runtime, {
      base,
      declared,
      declaredNode,
    }),
  )

  // 清单里的文件键统一是正斜杠，比较前先归一化，避免 Windows 反斜杠造成假失败。
  const licenses = (npmOverlay ? distribution.license.files : licenseTargets()).map((file) =>
    file.split(sep).join('/'),
  )
  const missingLicenses = licenses.filter((file) => !existsSync(join(base, file)))
  check(
    'licenses-present',
    missingLicenses.length === 0,
    missingLicenses.length
      ? `缺少 ${missingLicenses.slice(0, 3).join(', ')}`
      : `${licenses.length} 份`,
  )
  const emptyLicenses = licenses.filter((file) => {
    const path = join(base, file)
    return existsSync(path) && readFileSync(path).length === 0
  })
  check('licenses-non-empty', emptyLicenses.length === 0, emptyLicenses.join(', ') || '非空')
  if (npmOverlay)
    check(
      'official-license-digest',
      existsSync(join(base, 'LICENSE')) &&
        sha256File(join(base, 'LICENSE')) === distribution.license.sha256,
    )

  try {
    scanForCredentials(base)
    check('no-credentials', true, '候选目录内未发现凭据或官方账号数据')
  } catch (error) {
    check('no-credentials', false, error.message)
  }

  const unsafe = []
  for (const entry of manifest.files) {
    try {
      assertRelativeInside(entry.file, '清单条目')
    } catch (error) {
      unsafe.push(error.message)
    }
  }
  check(
    'manifest-paths-relative',
    unsafe.length === 0,
    unsafe.length ? unsafe.slice(0, 3).join('；') : `${manifest.files.length} 个条目均为相对路径`,
  )

  const actual = candidateFiles(base).filter(
    (file) => !(manifestInside && relative(base, manifestFile).split(sep).join('/') === file),
  )
  const undeclared = actual.filter((file) => !declared.has(file))
  const absent = [...declared].filter((file) => !actual.includes(file))
  check(
    'manifest-covers-all-files',
    undeclared.length === 0 && absent.length === 0,
    undeclared.length || absent.length
      ? `未登记：${undeclared.slice(0, 3).join(', ') || '无'}；缺失：${absent.slice(0, 3).join(', ') || '无'}`
      : `${actual.length} 个文件全部登记`,
  )

  // 摘要与字节数都要对上：只比 sha256 会让「字节数声明」变成没人核对的形式字段。
  const mismatched = manifest.files
    .map((entry) => {
      const file = assertRelativeInside(entry.file)
      const path = join(base, file)
      if (!existsSync(path)) return { file, reason: '缺失' }
      const size = statSync(path).size
      if (size !== entry.bytes) return { file, reason: `字节数 ${size} ≠ ${entry.bytes}` }
      if (sha256File(path) !== entry.sha256) return { file, reason: 'sha256 不符' }
      return { file, ok: true }
    })
    .filter((entry) => !entry.ok)
  check(
    'manifest-digests',
    mismatched.length === 0,
    mismatched.length
      ? `不一致：${mismatched
          .slice(0, 5)
          .map((entry) => `${entry.file}（${entry.reason}）`)
          .join(', ')}`
      : `${manifest.files.length} 个文件的摘要与字节数一致`,
  )
  const uncoveredLicenses = licenses.filter((file) => !declared.has(file))
  check(
    'licenses-covered-by-manifest',
    uncoveredLicenses.length === 0,
    uncoveredLicenses.length ? `未纳入摘要：${uncoveredLicenses.join(', ')}` : '许可文件都在清单内',
  )

  const capabilities = detectCapabilities(base)
  check(
    'capability-bundle-scanned',
    capabilities.bundleScanned,
    capabilities.bundleScanned ? '已扫描' : '没有可扫描的 bundle',
  )
  check(
    'capability-markers-present',
    capabilities.markersPresent,
    JSON.stringify(capabilities.bundleMarkers),
  )
  const history = plan.capability.acpSessionHistory
  const declaredMarkers = [
    plan.capability.acpMetaKey,
    history.metaKey,
    history.clientRequestIdMetaKey,
    ...history.methods,
    ...history.notifications,
  ]
  const historyScan = scanBundleMarkers(base, declaredMarkers)
  check(
    'capability-acp-session-history-declared',
    historyScan.scanned && historyScan.missing.length === 0,
    historyScan.missing.length
      ? `缺少标记：${historyScan.missing.slice(0, 3).join(', ')}`
      : `${declaredMarkers.length} 个声明标记都在 bundle 内`,
  )

  const declaredExternal = manifest.externalModules
  const requiredExternal = npmOverlay ? distribution.externalModules : plan.build.externalModules
  const externalDeclared =
    Array.isArray(declaredExternal?.copied) &&
    requiredExternal.every((name) => declaredExternal.copied.includes(name))
  check('external-modules-declared', externalDeclared, `需要 ${requiredExternal.join(', ')}`)
  const closure = verifyExternalModuleClosure(
    npmOverlay ? join(base, 'official') : base,
    requiredExternal,
  )
  check(
    'external-modules-closure-inside-candidate',
    closure.ok,
    closure.ok
      ? `闭包 ${closure.resolved} 个包全部解析在候选目录内`
      : [
          closure.missing.length ? `缺包：${closure.missing.slice(0, 3).join(', ')}` : '',
          closure.escaped.length ? `逃出候选目录：${closure.escaped.slice(0, 3).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('；'),
  )

  return finish(checks, {
    version: shapeOk ? declaredVersion : null,
    manifestPath: manifestFile,
    base,
    manifest,
    capabilities,
    launcherPath,
    externalClosure: closure,
  })

  function finish(all, extra) {
    const failed = all.filter((item) => !item.ok).map((item) => item.name)
    return {
      ...extra,
      checks: all,
      passed: failed.length === 0,
      failed,
      manifestSha256:
        extra.manifestPath && existsSync(extra.manifestPath)
          ? sha256File(extra.manifestPath)
          : null,
      launcherSha256:
        extra.launcherPath && existsSync(extra.launcherPath)
          ? sha256File(extra.launcherPath)
          : null,
      networkUsed: NETWORK_ACCESS,
    }
  }
}

// ---------------------------------------------------------------- 集成状态

/**
 * 本脚本的边界声明：它**只**维护自己的选择回执，不写 DSH 的真实运行时选择。
 *
 * 把回执变成真实选择需要主审接既有的公开接口（本目录不改这些共享文件）：
 *   RPC `oplExecution/save-catalog`（`src/execution/host/service.ts` 的 `saveCatalog`，
 *   落盘由 `src/execution/host/catalog.ts` 的 `ExecutionCatalogStore.set()` 原子完成），
 *   把 `harnesses` 里 `id === 'minimax-code'` 的 `command` 设为候选启动器的绝对路径；
 *   切回官方时改回 `'mcode'` 或官方安装目录的绝对路径。
 * 客户端侧同一个字段就是设置 → Harness 卡片的“可执行文件路径”
 * （`src/execution/client/use-harness-settings.ts` 的 `savePath`）。
 *
 * 在接线之前，`selection.json` 只是审计回执：它不改变任何 MiniMax 组合的实际启动器。
 */
export const RUNTIME_SELECTION_INTEGRATION = {
  wiredByLifecycle: false,
  receiptOnly: true,
  publicInterface: 'oplExecution/save-catalog（src/execution/host/service.ts 的 saveCatalog）',
  field: "ExecutionCatalog.harnesses[id='minimax-code'].command = <候选目录>/mcode.cmd 的绝对路径",
  switchBackField: "把同一字段改回 'mcode' 或官方安装目录的绝对路径",
  activity:
    '调用方必须用公开活动状态提供 --active-tasks；本脚本不探活，也不保证它与真实全局活动一致',
}

// ---------------------------------------------------------------- 活动任务闸门

/**
 * 活动任务数来自调用方注入的公开状态，不来自本脚本探活：
 *   `activeTasks`（数字）或 `activity`（JSON 文件，读 `{ activeTasks }`）。
 * 两个都没给就拒绝切换——宁可拒绝，也不能在不知道是否有任务运行时改选择。
 *
 * 注意语义边界：这是**调用方断言**，不是全局活动检查。注入 `0` 只能说明调用方说当前空闲；
 * 脚本无法验证它与真实运行中的会话/任务一致，因此在并行活动期间它不构成「可安全切换」的证据。
 */
export function resolveActiveTasks({ activeTasks, activity, env = process.env } = {}) {
  const note = '调用方注入的公开状态；本脚本不探活，也不验证它与真实全局活动一致。'
  if (activeTasks !== undefined && activeTasks !== null && activeTasks !== '') {
    const value = Number(activeTasks)
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`--active-tasks 必须是非负整数，收到 ${JSON.stringify(activeTasks)}。`)
    return { activeTasks: value, source: 'caller-argument', injected: true, note }
  }
  if (activity) {
    const path = resolve(activity)
    if (!existsSync(path)) throw new Error(`活动状态文件不存在：${path}`)
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`活动状态文件无法解析：${path}（${error.message}）`)
    }
    const value = parsed?.activeTasks
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`活动状态文件缺少非负整数 activeTasks：${path}`)
    return { activeTasks: value, source: path, injected: true, note }
  }
  void env
  throw new Error(
    '切换选择必须注入公开状态：--active-tasks <非负整数> 或 --activity <JSON 文件>；不自行探活。',
  )
}

export function assertNoActiveTasks(resolved, action) {
  if (resolved.activeTasks !== 0)
    throw new Error(
      `存在 ${resolved.activeTasks} 个活动任务（来源 ${resolved.source}），拒绝${action}；等任务结束后重试。`,
    )
  return resolved
}

// ---------------------------------------------------------------- 导入与选择

function copyCandidateTree(sourceDir, destination, manifestFile) {
  mkdirp(destination)
  cpSync(sourceDir, destination, { recursive: true, dereference: false, force: true })
  const target = join(destination, 'manifest.json')
  if (resolve(manifestFile) !== resolve(target)) copyFileSync(manifestFile, target)
  return target
}

/** 官方启动器只用存在性判断解析；找不到也允许切回，只是记录 unresolved。 */
export function resolveOfficialLauncher({ officialLauncher, env = process.env } = {}) {
  if (officialLauncher) {
    const resolved = resolveCommandPath(officialLauncher, env)
    return { launcher: officialLauncher, resolved: resolved || null }
  }
  const command = process.platform === 'win32' ? 'mcode.cmd' : 'mcode'
  const resolved = resolveCommandPath(command, env)
  return { launcher: resolved || command, resolved: resolved || null }
}

function requireStore(options) {
  const env = options.env ?? process.env
  const storeRoot = assertStoreRoot(options.store ?? defaultStoreRoot(env), {
    env,
    allowRoots: options.allowRoots ?? [],
    extraRoots: options.extraRoots ?? [],
  })
  return { env, storeRoot }
}

function verifyOptions(options, env) {
  return {
    env,
    extraRoots: options.extraRoots ?? [],
    manifestPath: options.manifest,
    version: options.version,
  }
}

/**
 * 导入一个新候选：先只读校验来源，再复制到版本目录，再对**目标目录**重新校验一遍，
 * 最后（可选）写入选择。全程不执行候选代码、不联网。
 */
export function importCandidate(options = {}) {
  const dryRun = options.dryRun === true
  const { env, storeRoot } = requireStore(options)
  const source = resolve(required(options.source, '--source <候选目录>'))
  const verification = verifyImportCandidate(source, verifyOptions(options, env))
  if (!verification.passed)
    return {
      command: 'import',
      dryRun,
      applied: false,
      ok: false,
      storeRoot,
      source,
      failed: verification.failed,
      checks: verification.checks,
      networkUsed: NETWORK_ACCESS,
      selectionChanged: false,
    }
  const version = verification.version
  const destination = versionDir(storeRoot, version)
  const previous = readSelection(storeRoot)
  const selectionRequested = options.select === true
  const wantsSwitch = selectionRequested || options.upgrade === true

  // 切换前先算清楚：活动任务闸门与升级方向都在复制之前判定，避免留下用不上的版本目录。
  let activeTasks = null
  let direction = null
  if (wantsSwitch) {
    activeTasks = assertNoActiveTasks(
      resolveActiveTasks({ activeTasks: options.activeTasks, activity: options.activity, env }),
      options.upgrade ? '升级候选' : '切换候选',
    )
    if (options.upgrade) {
      if (previous?.selection?.kind !== 'candidate')
        throw new Error('当前没有已选择的候选版；请先用 import --select 完成首次导入。')
      direction = compareVersions(version, previous.selection.version)
      if (direction <= 0 && options.allowSameOrOlder !== true)
        throw new Error(
          `升级目标 ${version} 不高于当前选择 ${previous.selection.version}；如确实要切回旧版，请显式 --allow-same-or-older。`,
        )
    }
  }

  // 所有派生路径必须在**任何**复制或改名之前逐个验证：assertStoreRoot 只证明 Store 根
  // 落在套件自有位置，而 `verification/`、版本目录、回执的现存祖先可能是 junction。
  const verificationTarget = verificationDir(storeRoot, version)
  const extraRoots = options.extraRoots ?? []
  assertDerivedTargets(
    storeRoot,
    [
      { path: destination, label: '版本目录' },
      { path: verificationTarget, label: '校验报告目录' },
      ...(wantsSwitch ? [{ path: selectionPath(storeRoot), label: '选择回执' }] : []),
    ],
    { env, extraRoots },
  )

  // 来源目录不能别名到 Store 内部：从 Store 自己导入没有意义，且可能是链接绕过。
  if (containsPath(storeRoot, resolveThroughExistingAncestors(source)))
    throw new Error(`来源目录位于候选 Store 内，拒绝自我导入：${source}`)

  const selectedVersion =
    previous?.selection?.kind === 'candidate' ? previous.selection.version : null
  let alreadyImported = false
  let rotateTo = null
  let existingVerification = null
  if (existsSync(destination)) {
    const replacing = options.replace === true
    // 不能替换当前已选择的版本：回执里的启动器绝对路径会指向被改名的旧目录。
    if (replacing && selectedVersion === version)
      throw new Error(
        `不能 --replace 当前已选择的候选版本 ${version}；先 select 到别的版本或切回官方，再替换它。`,
      )
    existingVerification = verifyImportCandidate(destination, {
      env,
      extraRoots,
      manifestPath: join(destination, 'manifest.json'),
      version,
    })
    if (
      existingVerification.passed &&
      existingVerification.manifestSha256 === verification.manifestSha256
    )
      alreadyImported = true
    else if (!replacing)
      throw new Error(
        `目标版本目录已存在且与来源不一致：${destination}。换版本号，或显式 --replace（旧目录改名保留）。`,
      )
    else rotateTo = `${destination}.previous-${Date.now()}`
  }

  const stamp = Date.now()
  // 先在 Store 内复制暂存目录、校验暂存目录，通过之后才动既有版本目录；
  // 任何一步失败都恢复原目录，暂存/失败产物留在 Store 内，原版本目录从不删除。
  const stagingDir = `${destination}.staging-${stamp}`
  const failedDir = `${destination}.failed-${stamp}`
  if (!alreadyImported)
    assertDerivedTargets(
      storeRoot,
      [
        { path: stagingDir, label: '暂存目录' },
        { path: failedDir, label: '失败保留目录' },
      ],
      { env, extraRoots },
    )
  if (rotateTo)
    assertDerivedTargets(storeRoot, [{ path: rotateTo, label: '旧版本保留目录' }], {
      env,
      extraRoots,
    })

  const plan_ = {
    command: options.upgrade ? 'upgrade' : 'import',
    dryRun,
    storeRoot,
    source,
    manifest: verification.manifestPath,
    version,
    destination,
    alreadyImported,
    replace: options.replace === true,
    rotateTo,
    stagingDir: alreadyImported ? null : stagingDir,
    selectionRequested,
    activeTasks,
    upgradeDirection: direction,
    previousSelection: previous?.selection ?? null,
    selectedVersion,
    manifestSha256: verification.manifestSha256,
    launcher: verification.launcherPath,
    launcherSha256: verification.launcherSha256,
    checks: verification.checks,
    networkUsed: NETWORK_ACCESS,
    integration: RUNTIME_SELECTION_INTEGRATION,
    warnings: wantsSwitch
      ? [
          'selection.json 只是本脚本的审计回执，不是 DSH 的真实运行时选择。',
          '要让 MiniMax 组合真正用上候选启动器，主审必须用公开接口 oplExecution/save-catalog 把',
          "harnesses[id='minimax-code'].command 设为该候选启动器的绝对路径；接线前切换不生效。",
          '本次的活动任务数由调用方注入，不是全局活动探测，也不构成全局安全锁。',
        ]
      : [],
    // 无论是否 dry-run 都列出计划写入，便于他人先审再执行；dry-run 时 applied 恒为 false。
    writes: [
      ...(alreadyImported ? [] : [{ action: 'stage', to: stagingDir }]),
      ...(rotateTo ? [{ action: 'rotate', to: rotateTo }] : []),
      ...(alreadyImported ? [] : [{ action: 'publish', to: destination }]),
      { action: 'verification-report', to: join(verificationTarget, 'import-verification.json') },
      ...(wantsSwitch ? [{ action: 'selection', to: selectionPath(storeRoot) }] : []),
    ],
  }
  if (dryRun) return { ...plan_, applied: false, ok: true, selectionChanged: false }

  let finalVerification = existingVerification
  let published = false
  let rotated = false
  try {
    if (!alreadyImported) {
      copyCandidateTree(source, stagingDir, verification.manifestPath)
      const recheck = verifyImportCandidate(stagingDir, {
        env,
        extraRoots,
        manifestPath: join(stagingDir, 'manifest.json'),
        version,
      })
      if (!recheck.passed) {
        renameSync(stagingDir, failedDir)
        return {
          ...plan_,
          applied: false,
          ok: false,
          failed: recheck.failed,
          checks: recheck.checks,
          failedDir,
          restored: true,
          selectionChanged: false,
        }
      }
      finalVerification = recheck
      if (rotateTo) {
        renameSync(destination, rotateTo)
        rotated = true
      }
      renameSync(stagingDir, destination)
      published = true
    }
    mkdirp(verificationTarget)
    writeJsonAtomically(
      storeRoot,
      join(verificationTarget, 'import-verification.json'),
      {
        version,
        source,
        destination,
        verifiedAt: new Date().toISOString(),
        passed: finalVerification.passed,
        failed: finalVerification.failed,
        checks: finalVerification.checks,
        manifestSha256: finalVerification.manifestSha256,
        launcherSha256: finalVerification.launcherSha256,
        networkUsed: NETWORK_ACCESS,
        candidateCodeExecuted: false,
      },
      { env, extraRoots },
    )

    let receipt = previous
    let selectionChanged = false
    if (wantsSwitch) {
      const launcher = join(destination, plan.launcher.windows)
      receipt = buildReceipt({
        storeRoot,
        previous,
        selection: {
          kind: 'candidate',
          version,
          launcher,
          launcherSha256: sha256File(launcher),
          manifestSha256: finalVerification.manifestSha256,
          officialBase: version.split('-opl-bash.')[0],
          verifiedAt: new Date().toISOString(),
        },
        official: previous?.official ?? {
          launcher: null,
          resolved: null,
          note: '未记录官方启动器',
        },
      })
      const entry = receipt.candidates.find((item) => item.version === version)
      if (entry) {
        entry.manifestSha256 = finalVerification.manifestSha256
        entry.verified = true
        entry.importedAt = entry.importedAt ?? new Date().toISOString()
      }
      // writeSelection 是原子写：写失败时旧回执逐字节不变。
      writeSelection(storeRoot, receipt, { env, extraRoots })
      selectionChanged = true
    }
    return { ...plan_, applied: true, ok: true, receipt, selectionChanged, restored: false }
  } catch (error) {
    // 失败必须把 Store 恢复到写入前的状态，并且如实报告恢复结果，
    // 绝不能在同一份返回值里既说 applied:false 又把原目录留在 move 之后。
    const rollback = rollbackImport({
      destination,
      stagingDir,
      failedDir,
      rotateTo,
      published,
      rotated,
    })
    return {
      ...plan_,
      applied: false,
      ok: false,
      error: error.message,
      ...rollback,
      selectionChanged: false,
    }
  }
}

/**
 * 导入失败后的恢复：把已发布的暂存目录挪成 `<版本>.failed-<ts>` 保留，再把被改名的原目录
 * 改回目标位置。回执是原子写，失败时本来就没变，因此不需要也不应该在这里重写。
 */
function rollbackImport({ destination, stagingDir, failedDir, rotateTo, published, rotated }) {
  const problems = []
  let keptFailed = null
  if (published && existsSync(destination)) {
    keptFailed = existsSync(failedDir) ? `${failedDir}-${Date.now()}` : failedDir
    try {
      renameSync(destination, keptFailed)
    } catch (error) {
      keptFailed = null
      problems.push(`无法移开已发布目录：${error.message}`)
    }
  }
  if (rotated && rotateTo && existsSync(rotateTo)) {
    try {
      renameSync(rotateTo, destination)
    } catch (error) {
      problems.push(`无法把原目录改回 ${destination}：${error.message}`)
    }
  }
  const restored =
    problems.length === 0 && (!rotated || existsSync(destination)) && !existsSync(rotateTo)
  if (!published && existsSync(stagingDir)) problems.push(`暂存目录仍在：${stagingDir}`)
  return {
    restored,
    originalRestored: restored,
    failedDir: keptFailed,
    stagingDir: published ? null : stagingDir,
    rollbackProblems: problems,
  }
}

/** 显式选择一个已导入的候选版本。 */
export function selectCandidate(options = {}) {
  const dryRun = options.dryRun === true
  const { env, storeRoot } = requireStore(options)
  const version = required(options.version, '--version <候选版本>')
  const destination = versionDir(storeRoot, version)
  // 已导入的版本目录与回执都是派生路径：现存祖先可能是 junction，读写之前逐个判定。
  assertDerivedTargets(
    storeRoot,
    [
      { path: destination, label: '版本目录' },
      { path: selectionPath(storeRoot), label: '选择回执' },
    ],
    { env, extraRoots: options.extraRoots ?? [] },
  )
  if (!existsSync(destination)) throw new Error(`尚未导入该候选版本：${destination}`)
  const verification = verifyImportCandidate(destination, {
    env,
    extraRoots: options.extraRoots ?? [],
    manifestPath: join(destination, 'manifest.json'),
    version,
  })
  if (!verification.passed)
    return {
      command: 'select',
      dryRun,
      applied: false,
      ok: false,
      storeRoot,
      version,
      failed: verification.failed,
      checks: verification.checks,
      selectionChanged: false,
    }
  const activeTasks = assertNoActiveTasks(
    resolveActiveTasks({ activeTasks: options.activeTasks, activity: options.activity, env }),
    '切换候选',
  )
  const previous = readSelection(storeRoot)
  const launcher = join(destination, plan.launcher.windows)
  const selection = {
    kind: 'candidate',
    version,
    launcher,
    launcherSha256: sha256File(launcher),
    manifestSha256: verification.manifestSha256,
    officialBase: version.split('-opl-bash.')[0],
    verifiedAt: new Date().toISOString(),
  }
  const plan_ = {
    command: 'select',
    dryRun,
    storeRoot,
    version,
    destination,
    launcher,
    activeTasks,
    previousSelection: previous?.selection ?? null,
    checks: verification.checks,
    networkUsed: NETWORK_ACCESS,
    integration: RUNTIME_SELECTION_INTEGRATION,
    warnings: [
      'selection.json 只是本脚本的审计回执，不是 DSH 的真实运行时选择；写入它不会改变 MiniMax 组合。',
      "要让选择生效，主审必须用公开接口 oplExecution/save-catalog 把 harnesses[id='minimax-code'].command 设为：",
      launcher,
      '本次的活动任务数由调用方注入，不是全局活动探测，也不构成全局安全锁。',
    ],
  }
  if (dryRun) return { ...plan_, applied: false, ok: true, selectionChanged: false }
  const receipt = buildReceipt({
    storeRoot,
    previous,
    selection,
    official: previous?.official ?? { launcher: null, resolved: null, note: '未记录官方启动器' },
  })
  const entry = receipt.candidates.find((item) => item.version === version)
  if (entry) {
    entry.manifestSha256 = verification.manifestSha256
    entry.verified = true
    entry.importedAt = entry.importedAt ?? new Date().toISOString()
  }
  writeSelection(storeRoot, receipt, { env, extraRoots: options.extraRoots ?? [] })
  return { ...plan_, applied: true, ok: true, receipt, selectionChanged: true }
}

/**
 * 切回官方安装：只改本脚本的选择回执，不动官方安装、账号数据与任何候选目录。
 * 注意官方 0.6.3 不提供 ACP `_meta["minimax-code/shell"]` 与会话历史接口，
 * 切回官方后 MiniMax 组合会在发送前按设计被拒绝。
 */
export function switchToOfficial(options = {}) {
  const dryRun = options.dryRun === true
  const { env, storeRoot } = requireStore(options)
  const activeTasks = assertNoActiveTasks(
    resolveActiveTasks({ activeTasks: options.activeTasks, activity: options.activity, env }),
    '切回官方',
  )
  assertDerivedTargets(storeRoot, [{ path: selectionPath(storeRoot), label: '选择回执' }], {
    env,
    extraRoots: options.extraRoots ?? [],
  })
  const previous = readSelection(storeRoot)
  const official = resolveOfficialLauncher({ officialLauncher: options.officialLauncher, env })
  const selection = {
    kind: 'official',
    version: null,
    launcher: official.resolved ?? official.launcher,
    launcherSha256: official.resolved ? sha256File(official.resolved) : null,
    officialBase: plan.official.version,
    verifiedAt: new Date().toISOString(),
  }
  const plan_ = {
    command: 'official',
    dryRun,
    storeRoot,
    activeTasks,
    official,
    previousSelection: previous?.selection ?? null,
    integration: RUNTIME_SELECTION_INTEGRATION,
    warnings: [
      'selection.json 只是本脚本的审计回执，不是 DSH 的真实运行时选择。',
      "要让切回生效，主审必须用公开接口 oplExecution/save-catalog 把 harnesses[id='minimax-code'].command 改回：",
      official.resolved ?? official.launcher,
      '本次的活动任务数由调用方注入，不是全局活动探测，也不构成全局安全锁。',
      '官方 0.6.3 不提供 ACP _meta["minimax-code/shell"] 与会话历史接口；',
      '切回后 MiniMax 组合会在发送前按设计被拒绝，不会静默退回 PowerShell/CMD/WSL。',
      official.resolved
        ? null
        : `未在 PATH 上解析到官方 ${process.platform === 'win32' ? 'mcode.cmd' : 'mcode'}；请用 --official-launcher 指定绝对路径。`,
    ].filter(Boolean),
    networkUsed: NETWORK_ACCESS,
  }
  if (dryRun) return { ...plan_, applied: false, ok: true, selectionChanged: false }
  const receipt = buildReceipt({
    storeRoot,
    previous,
    selection,
    official: {
      launcher: official.resolved ?? official.launcher,
      resolved: official.resolved,
      note: '官方安装与账号数据未被本脚本修改；切换方式见 docs/minimax-bash-candidate.md。',
    },
  })
  writeSelection(storeRoot, receipt, { env, extraRoots: options.extraRoots ?? [] })
  return { ...plan_, applied: true, ok: true, receipt, selectionChanged: true }
}

/** 只读列出候选与当前选择。 */
export function listCandidates(options = {}) {
  const { env, storeRoot } = requireStore(options)
  const selection = readSelection(storeRoot)
  return {
    command: 'list',
    dryRun: true,
    applied: false,
    ok: true,
    storeRoot,
    selection: selection?.selection ?? null,
    history: selection?.history ?? [],
    preserved: selection?.preserved ?? {},
    integration: RUNTIME_SELECTION_INTEGRATION,
    candidates: listImportedVersions(storeRoot).map((version) => {
      const launcher = join(versionDir(storeRoot, version), plan.launcher.windows)
      return {
        version,
        launcher: existsSync(launcher) ? launcher : null,
        report: existsSync(join(verificationDir(storeRoot, version), 'import-verification.json'))
          ? join(verificationDir(storeRoot, version), 'import-verification.json')
          : null,
      }
    }),
    networkUsed: NETWORK_ACCESS,
  }
}

/** 只读校验一个候选目录，不导入、不选择、不写任何文件。 */
export function verifyOnly(options = {}) {
  const env = options.env ?? process.env
  const source = resolve(required(options.source, '--source <候选目录>'))
  const verification = verifyImportCandidate(source, verifyOptions(options, env))
  return {
    command: 'verify',
    dryRun: true,
    applied: false,
    ok: verification.passed,
    source,
    version: verification.version,
    manifestSha256: verification.manifestSha256,
    launcherSha256: verification.launcherSha256,
    failed: verification.failed,
    checks: verification.checks,
    networkUsed: NETWORK_ACCESS,
    // 能力标记只证明补丁进了 bundle；真实 ACP 回读与真实 Bash 执行必须由主审实机验收。
    runtimeValidation: {
      verifiedByThisScript: false,
      reason:
        '本脚本只做静态与摘要检查，不执行候选代码、不发起 ACP；真实 _meta["minimax-code/shell"] 回读、会话历史接口与真实 Bash 执行不在离线检查范围内。',
    },
  }
}

export function runLifecycle(command, options = {}) {
  switch (command) {
    case 'list':
      return listCandidates(options)
    case 'verify':
      return verifyOnly(options)
    case 'import':
      return importCandidate(options)
    case 'upgrade':
      return importCandidate({ ...options, upgrade: true, select: true })
    case 'select':
      return selectCandidate(options)
    case 'official':
      return switchToOfficial(options)
    default:
      throw new Error(
        `未知命令 ${JSON.stringify(command)}；可用：list/verify/import/upgrade/select/official。`,
      )
  }
}

// ---------------------------------------------------------------- 命令行

export function parseLifecycleArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      store: { type: 'string' },
      source: { type: 'string' },
      manifest: { type: 'string' },
      version: { type: 'string' },
      select: { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'active-tasks': { type: 'string' },
      activity: { type: 'string' },
      'allow-root': { type: 'string', multiple: true },
      protect: { type: 'string', multiple: true },
      'official-launcher': { type: 'string' },
      'allow-same-or-older': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })
  return {
    command: positionals[0],
    options: {
      store: values.store,
      source: values.source,
      manifest: values.manifest,
      version: values.version,
      select: values.select,
      replace: values.replace,
      dryRun: values['dry-run'],
      activeTasks: values['active-tasks'],
      activity: values.activity,
      allowRoots: (values['allow-root'] ?? []).map((value) => resolve(value)),
      extraRoots: (values.protect ?? []).map((value) => resolve(value)),
      officialLauncher: values['official-launcher'],
      allowSameOrOlder: values['allow-same-or-older'],
      json: values.json,
    },
  }
}

function summarize(result) {
  const lines = [`命令：${result.command}${result.dryRun ? '（dry-run，未写入）' : ''}`]
  lines.push(`结果：${result.ok ? 'OK' : '失败'}`)
  for (const key of ['storeRoot', 'source', 'version', 'destination', 'launcher'])
    if (result[key]) lines.push(`${key}：${result[key]}`)
  if (result.activeTasks)
    lines.push(
      `活动任务：${result.activeTasks.activeTasks}（来源 ${result.activeTasks.source}，调用方注入，非全局探测）`,
    )
  if (result.applied) lines.push('已应用')
  if (result.selectionChanged) lines.push('本地选择回执已更新')
  if (result.integration?.wiredByLifecycle === false)
    lines.push(
      `集成状态：回执未接线（真实选择需 ${result.integration.publicInterface} 设置 ${result.integration.field}）`,
    )
  if (result.runtimeValidation)
    lines.push(`运行时验收：本脚本未做（${result.runtimeValidation.reason}）`)
  if (result.failed?.length) lines.push(`失败项：${result.failed.join(', ')}`)
  for (const item of result.checks ?? [])
    lines.push(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
  for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`)
  if (result.candidates)
    lines.push(`候选：${result.candidates.map((item) => item.version).join(', ') || '（无）'}`)
  if (result.writes)
    lines.push(
      `计划写入：${result.writes.map((item) => `${item.action}→${item.to}`).join('；') || '（无）'}`,
    )
  return lines
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, options } = parseLifecycleArgs(process.argv.slice(2))
  if (!command)
    throw new Error(
      '用法：node scripts/mcode-candidate/lifecycle.mjs <list|verify|import|upgrade|select|official> [选项]',
    )
  const { json, ...rest } = options
  const result = runLifecycle(command, rest)
  if (json) console.log(JSON.stringify(result, null, 2))
  else for (const line of summarize(result)) console.log(line)
  if (!result.ok) process.exit(1)
}
