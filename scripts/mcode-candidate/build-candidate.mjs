#!/usr/bin/env node
/**
 * 从官方源码归档构建 MiniMax Bash 候选版。
 *
 * 默认只做预检并写出构建计划：核对官方归档摘要、解包、打补丁、写候选版本号、
 * 把官方构建链需要的 mcode-tools 归档放进它真正读取的缓存、暂存许可文件。
 * 预检默认会联网下载两份固定摘要的官方归档；`--offline` 需要同时提供
 * `--source-archive` 与 `--tools-archive`。
 *
 * 真正执行依赖安装、打包和门禁需要显式 `--execute`。`--toolchain-shim` 用一个替身脚本
 * 代替 pnpm 与 esbuild，只用于有界的入口编排自检；替身跑出来的产物一律标记为
 * stubbed，不能当作构建结果或分发物。
 *
 * 脚本只写 `--out` 指定的独占目录，与官方安装、官方登录数据和 OPL profile 双向不重叠，
 * 不写系统 PATH，不复制官方登录目录。
 */
import { copyFileSync, cpSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  assertCandidateVersion,
  assertDigest,
  assertWritableTarget,
  createTrace,
  downloadVerified,
  mkdirp,
  plan,
  run,
  tarVersion,
  toolVersion,
  writeJson,
} from './shared.mjs'
import {
  applyPatches,
  assertSupportedSource,
  copyExternalModules,
  describeNodeRuntime,
  detectCapabilities,
  extractOfficialSource,
  launcherContent,
  prefetchMcodeTools,
  prepareOutputRoot,
  scanForCredentials,
  stageLicenses,
  stampVersion,
  writeManifest,
} from './pipeline.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    version: { type: 'string' },
    execute: { type: 'boolean', default: false },
    replace: { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
    'source-archive': { type: 'string' },
    node: { type: 'string' },
    'system-node': { type: 'boolean', default: false },
    'toolchain-shim': { type: 'string' },
    'tools-archive': { type: 'string' },
    protect: { type: 'string', multiple: true },
  },
})

// 所有入口校验都在创建任何目录之前完成，避免为一次被拒的调用留下痕迹。
if (!values.out) throw new Error('必须提供 --out <独占输出目录>。')
if (values.node && values['system-node'])
  throw new Error('--node 与 --system-node 只能选一个：启动器使用的运行时来源必须显式。')
if (!values.node && !values['system-node'])
  throw new Error('必须用 --node <node.exe> 或 --system-node 显式声明启动器使用的运行时。')
if (values['toolchain-shim'] && !existsSync(resolve(values['toolchain-shim'])))
  throw new Error(`--toolchain-shim 不存在：${values['toolchain-shim']}`)
if (values.offline && !values['source-archive'])
  throw new Error('--offline 需要同时提供 --source-archive。')
if (values.offline && !values['tools-archive'])
  throw new Error(
    '--offline 需要同时提供 --tools-archive：官方构建链还会下载 mcode-tools 归档，本地缓存里没有它时无法离线预检。',
  )
if (values['tools-archive'] && !existsSync(resolve(values['tools-archive'])))
  throw new Error(`--tools-archive 不存在：${values['tools-archive']}`)
const version = assertCandidateVersion(values.version || plan.candidateVersion)
if (!version.startsWith(plan.official.version + '-opl-bash.'))
  throw Error(
    'This source builder only supports ' +
      plan.official.version +
      '; use build-distribution.mjs for the npm overlay.',
  )

const extraRoots = (values.protect ?? []).map((value) => resolve(value))
const { root: outDir, replaced } = prepareOutputRoot(values.out, {
  replace: values.replace,
  extraRoots,
})
const trace = createTrace(join(outDir, 'build-trace.jsonl'))
trace.record('start', { version, execute: values.execute, offline: values.offline, replaced })

const downloads = mkdirp(join(outDir, 'downloads'))
const work = mkdirp(join(outDir, 'work'))
const sourceRoot = join(work, 'src')

// 1. 官方归档：固定摘要优先；本地归档也必须与同一摘要一致。
let archive = values['source-archive'] ? resolve(values['source-archive']) : null
let archiveSource = 'local'
if (!archive) {
  archive = join(downloads, `minimax-code-${plan.official.tag}.tar.gz`)
  await downloadVerified(
    plan.official.archiveUrl,
    archive,
    { sha256: plan.official.archiveSha256 },
    trace,
    '官方源码归档',
  )
  archiveSource = 'download'
} else if (!existsSync(archive)) throw new Error(`--source-archive 不存在：${archive}`)
assertDigest(archive, plan.official.archiveSha256, '官方源码归档')
const archiveBytes = statSync(archive).size
if (archiveBytes !== plan.official.archiveBytes)
  throw new Error(
    `官方归档字节数 ${archiveBytes} 与声明的 ${plan.official.archiveBytes} 不符，拒绝继续。`,
  )
trace.record('archive', { source: archiveSource, bytes: archiveBytes })

// 2. 解包后先确认来源版本，未复核的新版本不会被旧补丁改写。
extractOfficialSource(archive, sourceRoot, trace)
const supported = assertSupportedSource(sourceRoot)

// 3. 打补丁：每个补丁先校验摘要与 --check。
const patches = applyPatches(sourceRoot, trace)

// 4. 写候选版本号（根清单与 TUI 清单必须一致）。
stampVersion(sourceRoot, version, trace)

// 5. 把官方构建链需要的 mcode-tools 归档放进它读取的缓存位置，之后构建不必联网。
// --tools-archive 提供本地已下载的官方归档：复制到临时位置后仍由 prefetch 按固定
// sha512 复核，摘要不符会在写入官方缓存之前拒绝。
const offlineFetch = async (url, destination, expectation, activeTrace, label) => {
  if (values['tools-archive']) {
    const source = resolve(values['tools-archive'])
    activeTrace?.record('local-tools-archive', { source, destination, expectation })
    copyFileSync(source, destination)
    return
  }
  if (values.offline) throw new Error(`--offline 模式下缺少 ${label} 本地归档：${url}`)
  return downloadVerified(url, destination, expectation, activeTrace, label)
}
const toolsArtifact = await prefetchMcodeTools(sourceRoot, downloads, trace, offlineFetch)

// 6. 暂存许可与声明，布局与验证器一致。
const licenses = stageLicenses(sourceRoot, work)

// 7. 启动器运行时来源必须显式，且记录版本与摘要。
const runtimePath = values.node ? resolve(values.node) : undefined
const runtime = describeNodeRuntime(runtimePath, trace)
const launcher = launcherContent(runtimePath)

const shim = values['toolchain-shim'] ? resolve(values['toolchain-shim']) : undefined
const buildPlan = {
  schemaVersion: plan.schemaVersion,
  candidateVersion: version,
  official: plan.official,
  source: supported,
  patches,
  toolsArtifact,
  licenses,
  nodeRuntime: runtime,
  launcher: { file: plan.launcher.windows, bytes: Buffer.byteLength(launcher) },
  toolchain: {
    stubbed: !!shim,
    shim: shim ?? null,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tar: tarVersion(trace),
    packageManager: toolVersion('pnpm', ['--version'], trace),
    declared: plan.build,
  },
  boundaries: {
    wroteSystemPath: false,
    modifiedOfficialInstall: false,
    copiedOfficialAccountData: false,
    publishedDistribution: false,
    trustworthyArtifact: false,
    declaredProtectedRoots: extraRoots,
  },
  gates: values.execute ? plan.build.gates : 'not-run',
  outputs: { outDir, sourceRoot, candidateDir: join(outDir, version) },
}
assertWritableTarget(join(outDir, 'build-plan.json'), {
  root: outDir,
  label: '构建计划',
  extraRoots,
})
writeJson(join(outDir, 'build-plan.json'), buildPlan)
trace.record('plan-written', { outDir, version })

if (!values.execute) {
  console.log(`预检完成，构建计划已写入 ${join(outDir, 'build-plan.json')}`)
  console.log('加 --execute 才会安装依赖、打包并运行门禁；本脚本不发布任何分发物。')
  process.exit(0)
}

// 8. 显式构建：依赖安装、打包、门禁，全部失败即停止，不产出候选目录。
// 每条命令都是 argv 数组；替身模式下改为调用 shim，并记录被替换的命令。
const phases = [
  ...plan.build.install.map((argv) => ({ phase: 'install', argv })),
  { phase: 'bundle', argv: plan.build.bundle },
  ...plan.build.gates.map((argv) => ({ phase: 'gate', argv })),
]
for (const { phase, argv } of phases) {
  if (shim) {
    run(['node', shim, phase, ...argv], { cwd: sourceRoot, trace })
    trace.record('stubbed-command', { phase, argv })
  } else run(argv, { cwd: sourceRoot, trace })
}

// 9. 组装候选目录：官方 dist、外部原生模块、许可、启动器、候选说明。
const candidateDir = join(outDir, version)
if (existsSync(candidateDir)) {
  const kept = `${candidateDir}.previous-${Date.now()}`
  renameSync(candidateDir, kept)
  trace.record('candidate-rotated', { from: candidateDir, to: kept })
}
mkdirp(candidateDir)
cpSync(join(sourceRoot, 'dist'), candidateDir, {
  recursive: true,
  filter: (file) => !file.endsWith('metafile.json'),
})
const external = copyExternalModules(sourceRoot, candidateDir, plan.build.externalModules)
writeFileSync(join(candidateDir, plan.launcher.windows), launcher, 'utf8')
cpSync(join(work, 'licenses'), join(candidateDir, 'licenses'), { recursive: true })
writeFileSync(
  join(candidateDir, 'CANDIDATE.md'),
  [
    '# MiniMax Bash candidate',
    '',
    `Local source build of official ${plan.official.tag} plus the shell selection patch in scripts/mcode-candidate.`,
    'This is not an official MiniMax release and does not follow official updates.',
    'Official launcher, official account data and the official Desktop stay untouched;',
    'select this launcher explicitly as the MiniMax Code Harness command to use it.',
    `Declared version: ${version}`,
    shim ? 'NOTE: assembled with a toolchain shim; this is not a real build.' : '',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n'),
  'utf8',
)
scanForCredentials(candidateDir)

const capabilities = detectCapabilities(candidateDir)
writeJson(join(candidateDir, 'capability-report.json'), capabilities)
const manifest = writeManifest(candidateDir, join(outDir, 'candidate-manifest.json'), {
  version,
  officialInstallModified: false,
  accountCopied: false,
  nodeRuntime: runtime,
  toolchainStubbed: !!shim,
  externalModules: external,
})
trace.record('published', { candidateDir, files: manifest.fileCount, external })
console.log(`候选目录已组装：${candidateDir}（${manifest.fileCount} 个文件）`)
if (external.unresolved.length)
  console.log(`外部模块依赖未在候选目录内解析：${external.unresolved.join(', ')}`)
if (shim) console.log('本次使用 toolchain 替身，产物不可当作构建结果或分发物。')
console.log(
  '未写系统 PATH，未改官方安装，未复制官方登录数据；切换方式见 docs/minimax-bash-candidate.md。',
)
