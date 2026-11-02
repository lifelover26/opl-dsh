/**
 * 候选构建的可复用步骤。构建脚本、验证脚本和自检脚本共用同一份实现，
 * 因此自检里验证的边界就是真实构建使用的边界。
 */
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  realpathSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertCandidateVersion,
  assertDigest,
  assertNotProtected,
  assertRelativeInside,
  assertSafeArchiveEntries,
  mkdirp,
  plan,
  run,
  resolveThroughExistingAncestors,
  scriptDir,
  sha256,
  sha256File,
  sha512Base64,
  toolVersion,
} from './shared.mjs'

const VERSION_PATTERN = /^\d+\.\d+\.\d+-opl-bash\.\d{8}\.\d+$/

/** 准备独占输出目录。已存在且非空时必须显式 --replace，旧目录只改名保留，不删除。 */
export function prepareOutputRoot(outDir, { replace = false, extraRoots = [] } = {}) {
  const root = assertNotProtected(resolve(outDir), process.env, '输出目录', extraRoots)
  if (existsSync(root)) {
    if (!replace) throw new Error(`输出目录已存在：${root}。换目录或显式 --replace。`)
    const kept = `${root}.previous-${Date.now()}`
    renameSync(root, kept)
    return { root: mkdirp(root), replaced: kept }
  }
  return { root: mkdirp(root), replaced: undefined }
}

/**
 * 校验解压出来的官方源码确实是本目录声明的那个版本。
 * 版本号和 release/extraction.json 记录的内部源码修订任一不符，都在打补丁之前失败，
 * 未复核的新版本不会被旧补丁改写。归档摘要是第一道闸门，这里是第二道。
 */
export function assertSupportedSource(sourceRoot) {
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'))
  const extraction = JSON.parse(readFileSync(join(sourceRoot, 'release/extraction.json'), 'utf8'))
  const expected = plan.official.extractedSourceRevision
  const mismatches = []
  if (manifest.version !== plan.official.version)
    mismatches.push(`package.json 版本 ${manifest.version} ≠ ${plan.official.version}`)
  if (extraction.sourceRevision !== expected)
    mismatches.push(
      `release/extraction.json sourceRevision ${extraction.sourceRevision} ≠ ${expected}`,
    )
  if (mismatches.length)
    throw new Error(
      `来源不是本目录复核过的官方 ${plan.official.tag}，拒绝应用本补丁：${mismatches.join('；')}。`,
    )
  return { version: manifest.version, sourceRevision: extraction.sourceRevision }
}

/**
 * Windows 上 GNU tar 把 `C:/...` 当成 `host:path` 远程归档，报 "Cannot connect to C"，
 * 因此对 GNU tar 固定加 --force-local；bsdtar 不接受该选项，按 tar --version 的实现区分。
 */
let gnuTar
function tarLocalFlag(trace) {
  if (gnuTar === undefined) {
    try {
      gnuTar = toolVersion('tar', ['--version'], trace).includes('GNU tar')
    } catch {
      gnuTar = false
    }
    trace?.record('tar', { implementation: gnuTar ? 'gnu+force-local' : 'native' })
  }
  return gnuTar ? ['--force-local'] : []
}

/**
 * tar 的路径参数一律用正斜杠。实测 Node 的 path.join 产生反斜杠路径时，GNU tar 会把它
 * 当成相对路径并报 "C\:\Users\...: Cannot open"；正斜杠路径在 Windows 上可用。
 */
function tarPath(path) {
  return path.replaceAll('\\', '/')
}

/** 解包官方归档：先固定摘要，再条目预检，最后用 --strip-components 去掉版本根目录。 */
export function extractOfficialSource(archive, sourceRoot, trace) {
  const local = tarLocalFlag(trace)
  const listing = run(['tar', ...local, '-tzf', tarPath(archive)], { trace })
    .split('\n')
    .filter(Boolean)
  assertSafeArchiveEntries(listing)
  const roots = new Set(listing.map((entry) => entry.replaceAll('\\', '/').split('/')[0]))
  if (roots.size !== 1 || !roots.has(plan.official.archiveRoot))
    throw new Error(
      `归档根目录是 ${[...roots].join(', ')}，与声明的 ${plan.official.archiveRoot} 不符，拒绝解包。`,
    )
  // 目标非空时不覆盖：上一轮的源码或补丁残留不能与这一轮混在一起。
  if (existsSync(sourceRoot) && readdirSync(sourceRoot).length)
    throw new Error(`解包目标非空：${sourceRoot}。换目录或先自行清理，避免与上一轮残留混合。`)
  mkdirp(sourceRoot)
  run(
    ['tar', ...local, '-xzf', tarPath(archive), '-C', tarPath(sourceRoot), '--strip-components=1'],
    { trace },
  )
  trace?.record('extract', { archive, sourceRoot, entries: listing.length })
  return listing.length
}

/** 逐个校验补丁摘要，先 --check 再真正应用；任一失败即停止，不留下半应用状态。 */
export function applyPatches(sourceRoot, trace, { ids } = {}) {
  const selected = plan.patches.filter((patch) => !ids || ids.includes(patch.id))
  if (!selected.length) throw new Error('没有选中任何补丁，拒绝产出未打补丁的候选版。')
  const applied = []
  for (const patch of selected) {
    const patchPath = join(scriptDir, patch.file)
    assertDigest(patchPath, patch.sha256, `补丁 ${patch.id}`)
    run(['git', 'apply', '-p1', '--verbose', '--check', patchPath], { cwd: sourceRoot, trace })
    run(['git', 'apply', '-p1', patchPath], { cwd: sourceRoot, trace })
    applied.push({ id: patch.id, file: patch.file, sha256: patch.sha256, touches: patch.touches })
    trace?.record('patch', { id: patch.id, touches: patch.touches })
  }
  return applied
}

/** 候选版本号写入根与 TUI 两个清单；官方构建脚本要求两处一致。 */
export function stampVersion(sourceRoot, version, trace) {
  assertCandidateVersion(version)
  if (!VERSION_PATTERN.test(version)) throw new Error(`候选版本号格式不合法：${version}`)
  const files = ['package.json', 'packages/tui/package.json']
  for (const file of files) {
    const path = join(sourceRoot, file)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.version = version
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
  const stamped = files.map(
    (file) => JSON.parse(readFileSync(join(sourceRoot, file), 'utf8')).version,
  )
  if (!stamped.every((value) => value === version))
    throw new Error(`版本号写入不一致：${files.join(' / ')} = ${stamped.join(' / ')}`)
  trace?.record('version', { version, files })
  return { version, files }
}

/**
 * 构建前取回官方构建链自己会下载的 mcode-tools 归档，并放进官方构建脚本真正读取的缓存位置。
 * 官方 `scripts/lib/mcode-tools-artifact.mjs` 的 `copyMcodeToolsArtifact` 只认
 * `<root>/.cache/artifacts/code-0.3.11.tgz`：只把文件留在 downloads 目录里，构建仍会联网。
 * 整包用 sha512 完整性值校验，包内 cli.mjs 的 sha256 由官方构建脚本自己再校验。
 */
export async function prefetchMcodeTools(sourceRoot, downloadDir, trace, fetchBytes) {
  const spec = plan.mcodeToolsArtifact
  const cachePath = join(sourceRoot, spec.cachePath)
  const verify = (bytes, origin) => {
    if (sha512Base64(bytes) !== spec.integritySha512)
      throw new Error('mcode-tools 归档 sha512 完整性不匹配，拒绝继续。')
    const observed = { origin, bytes: bytes.length, sha256: sha256(bytes), cachePath }
    trace?.record('mcode-tools', observed)
    return observed
  }
  if (existsSync(cachePath)) return verify(readFileSync(cachePath), 'cache')
  const download = join(downloadDir, 'code-0.3.11.tgz')
  await fetchBytes(
    spec.url,
    download,
    { integritySha512: spec.integritySha512 },
    trace,
    'mcode-tools 归档',
  )
  // 放回官方构建脚本读取的缓存位置，让随后的构建阶段不再联网。
  const verified = verify(readFileSync(download), 'download')
  mkdirp(resolve(cachePath, '..'))
  writeFileSync(cachePath, readFileSync(download))
  if (sha512Base64(readFileSync(cachePath)) !== spec.integritySha512)
    throw new Error('mcode-tools 归档写入官方缓存位置后完整性不一致。')
  trace?.record('mcode-tools-cached', { cachePath, sha256: verified.sha256 })
  return verified
}

/**
 * 许可与声明必须随候选目录一起分发，这是官方 LICENSE-STATUS.md 的要求。
 * 布局保持与源码相同的相对路径（`licenses/LICENSE`、`licenses/release/dependency-licenses.json`、
 * `licenses/third_party/pi-mono/LICENSE`），验证器按同一布局核对。
 */
export function stageLicenses(sourceRoot, stageDir) {
  const copies = [...plan.license.rootFiles, ...plan.license.extraFiles].map((file) => [
    file,
    join('licenses', file),
  ])
  for (const [from, to] of copies) {
    const source = join(sourceRoot, from)
    if (!existsSync(source)) throw new Error(`缺少必须保留的许可文件：${from}`)
    const target = join(stageDir, to)
    mkdirp(resolve(target, '..'))
    writeFileSync(target, readFileSync(source))
  }
  return copies.map(([from, to]) => ({ from, to }))
}

/** 许可文件在候选目录中的实际位置，验证器与组装阶段共用同一份。 */
export function licenseTargets() {
  return [...plan.license.rootFiles, ...plan.license.extraFiles].map((file) =>
    join('licenses', file),
  )
}

/**
 * 生成候选独立启动器。运行时不写进系统 PATH，也不改官方启动器文件。
 * 绝对路径直接引用；相对路径按启动器所在目录解析，便于随候选一起分发。
 */
export function launcherContent(runtimePath) {
  const runtime = runtimePath
    ? isAbsolute(runtimePath)
      ? `"${runtimePath}"`
      : `"%~dp0${runtimePath.split('\\').join('/')}"`
    : 'node'
  return [
    '@ECHO off',
    'REM MiniMax Bash candidate launcher. Not an official MiniMax release.',
    `${runtime} "%~dp0cli.js" %*`,
    'EXIT /B %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

/** 记录启动器使用的 Node 运行时来源与摘要，避免把来路不明的二进制写进候选目录。 */
export function describeNodeRuntime(runtimePath, trace) {
  if (!runtimePath) {
    const version = run(['node', '-p', 'process.versions.node'], { trace }).trim()
    return { path: 'system-node', version, sha256: null }
  }
  if (!existsSync(runtimePath)) throw new Error(`指定的 Node 运行时不存在：${runtimePath}`)
  const version = run([runtimePath, '-p', 'process.versions.node'], { trace }).trim()
  return { path: resolve(runtimePath), version, sha256: sha256File(runtimePath) }
}

/** 候选目录内出现账号数据或凭据即失败；官方登录目录永远不复制。 */
export function scanForCredentials(directory) {
  const suspicious = []
  const credentialNames = new Set([
    'auth',
    'auth.json',
    'credentials.json',
    'tokens.json',
    '.npmrc',
    'id_rsa',
    'id_ed25519',
  ])
  const walk = (current) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, item.name)
      if (item.isDirectory()) {
        if (item.name === 'node_modules' || item.name === 'chunks') continue
        if (credentialNames.has(item.name.toLowerCase())) suspicious.push(path)
        walk(path)
      } else if (credentialNames.has(item.name.toLowerCase())) suspicious.push(path)
    }
  }
  walk(directory)
  if (suspicious.length)
    throw new Error(`候选目录内发现凭据或账号数据文件：${suspicious.slice(0, 5).join(', ')}`)
  return true
}

/** 候选版与官方版分开的能力检测：静态标记只证明补丁进了产物，不等于运行时可用。 */
export function detectCapabilities(candidateDir, { scanBundle = true } = {}) {
  const markers = {}
  if (scanBundle) {
    const files = ['chunks', 'overlay'].flatMap((name) => {
      const root = join(candidateDir, name)
      return existsSync(root) ? walkFiles(root) : []
    })
    const haystack = files
      .filter((file) => /\.m?js$/.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    for (const marker of plan.capability.bundleMarkers) markers[marker] = haystack.includes(marker)
  }
  // 空标记集会让 Object.values({}).every() 成立，因此缺 bundle 或缺标记都按失败暴露。
  const bundleScanned = Object.keys(markers).length > 0
  const markersPresent = bundleScanned && Object.values(markers).every(Boolean)
  return {
    declaredAcpMeta: {
      key: plan.capability.acpMetaKey,
      version: plan.capability.acpMetaVersion,
      environment: 'MCODE_SHELL_PATH',
    },
    bundleScanned,
    bundleMarkers: markers,
    markersPresent,
    runtimeCapability: 'not-verified-by-this-script',
    runtimeVerification:
      '需要真实 ACP initialize 回读 _meta["minimax-code/shell"] 与真实工具执行；由主审实机验收。',
  }
}

function walkFiles(directory) {
  const found = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) found.push(...walkFiles(path))
    else if (item.isFile()) found.push(path)
  }
  return found
}

/** 候选目录内的实际文件集合，使用与清单一致的相对路径键。 */
export function candidateFiles(candidateDir) {
  return walkFiles(candidateDir)
    .map((path) =>
      path
        .slice(candidateDir.length + 1)
        .split('\\')
        .join('/'),
    )
    .sort()
}

/**
 * 候选目录清单：逐文件字节数与摘要，供安装前后比对。
 * 清单写在候选目录之外（不在 candidateDir 内），因此不会把自己算进文件集合；
 * 文件键统一校验为不逃逸的相对路径。
 */
export function writeManifest(candidateDir, manifestPath, extra) {
  const files = walkFiles(candidateDir)
    .map((path) => {
      const file = assertRelativeInside(path.slice(candidateDir.length + 1), '清单条目')
      return { file, bytes: statSync(path).size, sha256: sha256File(path) }
    })
    .sort((a, b) => (a.file < b.file ? -1 : 1))
  const manifest = {
    ...extra,
    officialSourceTag: plan.official.tag,
    officialSourceArchive: {
      url: plan.official.archiveUrl,
      tag: plan.official.tag,
      sha256: plan.official.archiveSha256,
      bytes: plan.official.archiveBytes,
    },
    officialInstallModified: false,
    accountCopied: false,
    fileCount: files.length,
    files,
  }
  mkdirp(resolve(manifestPath, '..'))
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

/**
 * 解析一个包的真实安装目录。沿用官方 scripts/package-cli-release.mjs 的做法：
 * 只按 require 的解析路径逐个查找候选目录，不读取任何与依赖解析无关的文件。
 */
export function resolvePackageDir(name, importer) {
  const require = createRequire(join(importer, 'package.json'))
  for (const search of require.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = join(search, name)
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        return resolve(realpathSync(candidate))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * 从某个目录出发，按 package.json 声明的 dependencies / optionalDependencies
 * 递归解析出完整闭包。返回每个包的真实路径，供复制与验证使用；
 * 只看一阶目录是否存在不足以说明闭包完整。
 */
export function resolveModuleClosure(fromDir, names) {
  const modules = new Map()
  const missing = []
  const queue = names.map((name) => ({ name, importer: fromDir, optional: false }))
  while (queue.length) {
    const { name, importer, optional } = queue.shift()
    const dir = resolvePackageDir(name, importer)
    if (!dir) {
      if (!optional && !missing.includes(name)) missing.push(name)
      continue
    }
    if (modules.has(dir)) continue
    let manifest = {}
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      missing.push(name)
      continue
    }
    modules.set(dir, { name, version: manifest.version ?? null, dir })
    const optionalDependencies = manifest.optionalDependencies ?? {}
    for (const dependency of Object.keys({
      ...(manifest.dependencies ?? {}),
      ...optionalDependencies,
    }))
      queue.push({
        name: dependency,
        importer: dir,
        optional: Object.hasOwn(optionalDependencies, dependency),
      })
  }
  return { modules, missing }
}

/**
 * 复制官方构建链里保持在 bundle 之外的原生/可选模块及其传递依赖。
 * 包内容解引用复制，依赖目录按实际依赖方重新组装，不保留指向构建树的链接。
 * 同名包的不同来源放在需要它的包下面；相同来源复用 Node 能解析到的祖先目录。
 * 解析不到的依赖如实报告，真实模块加载仍需单独验收。
 */
export function copyExternalModules(sourceRoot, candidateDir, names) {
  const { modules, missing } = resolveModuleClosure(sourceRoot, names)
  const copied = []
  const placements = []
  const targets = new Map()
  const origins = new Map()
  const queue = []
  const copy = (module, to) => {
    mkdirp(resolve(to, '..'))
    const dependencies = join(module.dir, 'node_modules')
    cpSync(module.dir, to, {
      recursive: true,
      dereference: true,
      filter: (file) => file !== dependencies,
    })
    origins.set(resolve(to), module.dir)
    copied.push(module.name)
    placements.push({
      name: module.name,
      version: module.version,
      path: relative(candidateDir, to).split(sep).join('/'),
    })
    queue.push({ module, to })
  }
  for (const module of modules.values()) {
    assertRelativeInside(module.name, '包名')
    if (!targets.has(module.name)) targets.set(module.name, module)
  }
  for (const module of targets.values()) {
    const to = join(candidateDir, 'node_modules', ...module.name.split('/'))
    copy(module, to)
  }
  while (queue.length) {
    const { module, to } = queue.shift()
    const manifest = JSON.parse(readFileSync(join(module.dir, 'package.json'), 'utf8'))
    for (const name of Object.keys({
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    })) {
      assertRelativeInside(name, '依赖包名')
      const source = resolvePackageDir(name, module.dir)
      if (!source) continue
      const existing = resolvePackageDir(name, to)
      if (existing && origins.get(existing) === source) continue
      const dependency = modules.get(source)
      if (!dependency) continue // 源包清单无效时，resolveModuleClosure 已登记缺失。
      copy(dependency, join(to, 'node_modules', ...name.split('/')))
    }
  }
  return {
    copied,
    placements,
    closureSize: copied.length,
    unresolved: missing,
    closureVerified: false,
    note: '闭包按 package.json 解析并复制；真实构建后的模块可加载性由主审在隔离环境验证。',
  }
}

/**
 * 从候选目录自身出发验证外部模块闭包：每个包都必须能从候选目录解析到，
 * 且真实路径不得落在构建树或仓库 node_modules 里。
 */
export function verifyExternalModuleClosure(candidateDir, names) {
  const base = resolveThroughExistingAncestors(candidateDir)
  const { modules, missing } = resolveModuleClosure(base, names)
  const escaped = []
  for (const module of modules.values()) {
    const span = relative(base, module.dir)
    if (span.startsWith(`..${sep}`) || span === '..' || isAbsolute(span))
      escaped.push(`${module.name} → ${module.dir}`)
  }
  return {
    resolved: modules.size,
    missing,
    escaped,
    ok: missing.length === 0 && escaped.length === 0,
  }
}

export { assertNotProtected }
