#!/usr/bin/env node
/**
 * 校验已构建的 MiniMax Bash 候选目录。
 *
 * 顺序是硬约束：先跑完全部静态先验检查（布局、清单 schema 与逐文件摘要、启动器内容、
 * 许可、凭据、外部模块闭包、能力标记、工具链是否替身），只有全部通过才允许执行候选
 * 代码。任何先验失败都零执行，只在报告里记录跳过的原因——不能靠子进程出错才算拒绝。
 *
 * 本脚本不联网、不安装、不调用模型；真实运行时是否换了 Shell 必须由主审用 ACP 回读与
 * 真实工具执行验收。入口 smoke 只在存在通过全部先验的真实构建产物时才运行，且始终使用
 * 隔离数据目录。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  assertRelativeInside,
  assertWritableTarget,
  mkdirp,
  plan,
  run,
  sha256File,
  writeJson,
} from './shared.mjs'
import {
  candidateFiles,
  detectCapabilities,
  launcherContent,
  licenseTargets,
  scanForCredentials,
  verifyExternalModuleClosure,
} from './pipeline.mjs'
import { verifyImportCandidate } from './lifecycle.mjs'

/** Apply the import gate to npm-based candidates before executing an isolated entry smoke. */
function verifyDistribution(candidateDir, outDir, options) {
  const verification = verifyImportCandidate(candidateDir, { manifestPath: options.manifestPath })
  const priorFailures = [...verification.failed]
  const smoke =
    priorFailures.length || options.smoke === false
      ? {
          ran: false,
          skipped: true,
          reason: priorFailures.length
            ? 'Static candidate validation failed.'
            : 'Entry smoke explicitly skipped.',
        }
      : isolatedEntrySmoke(candidateDir, assertWritableTarget(outDir, { label: '验证报告目录' }))
  const checks = [...verification.checks]
  if (!smoke.skipped)
    checks.push({
      name: 'isolated-entry-smoke',
      ok: smoke.ran && smoke.version === verification.version,
      detail: smoke.version ?? smoke.reason,
    })
  const report = {
    ...verification,
    manifest: undefined,
    checks,
    passed: checks.filter((item) => item.ok).length,
    failed: checks.filter((item) => !item.ok).map((item) => item.name),
    executionGate: {
      priorCheckFailures: priorFailures,
      candidateCodeExecuted: smoke.attempted === true,
      skippedReason: smoke.skipped ? smoke.reason : null,
    },
    isolatedEntrySmoke: smoke,
  }
  const reportPath = join(
    mkdirp(assertWritableTarget(outDir, { label: '验证报告目录' })),
    'candidate-verification.json',
  )
  writeJson(reportPath, report)
  return { ...report, reportPath }
}

/**
 * 候选目录内的启动器 smoke：在隔离数据目录下运行 `--version`，不读真实账号目录。
 * 调用方必须已经确认全部先验检查通过。
 */
export function isolatedEntrySmoke(candidateDir, reportDir, { stubbed = false } = {}) {
  const launcher = join(candidateDir, plan.launcher.windows)
  if (!existsSync(launcher)) return { ran: false, reason: '没有启动器' }
  // 先验证真实目标，再创建。
  const dataDir = mkdirp(
    assertWritableTarget(join(reportDir, 'entry-smoke-data'), { label: 'smoke 数据目录' }),
  )
  try {
    const output = run([launcher, '--version'], {
      capture: true,
      env: { ...process.env, MINIMAX_DATA_DIR: dataDir, MAVIS_DATA_DIR: dataDir },
    })
    return {
      ran: true,
      attempted: true,
      stubbed,
      dataDir,
      version: output.trim().split('\n')[0] ?? '',
    }
  } catch (error) {
    return { ran: false, attempted: true, stubbed, reason: error.message.split('\n')[0] }
  }
}

/** 校验候选目录并写报告，返回报告对象。命令行入口和自检脚本共用这一份实现。 */
export function verifyCandidate(candidateDir, outDir = join(candidateDir, '..'), options = {}) {
  const checks = []
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail })
    return ok
  }

  // 构建入口把清单写在候选目录之外（避免清单把自己算进文件集合）；
  // 手工整理的候选目录可以自带 manifest.json。
  const manifestPath = options.manifestPath
    ? resolve(options.manifestPath)
    : join(candidateDir, 'manifest.json')
  const base = resolve(candidateDir)
  const manifestInside = manifestPath === base || manifestPath.startsWith(base + sep)
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : undefined
  if (manifest?.distribution === 'official-npm-overlay')
    return verifyDistribution(candidateDir, outDir, { ...options, manifestPath })

  check('manifest-present', manifest, manifest ? manifestPath : `缺少清单：${manifestPath}`)
  const version = manifest?.version
  check(
    'version-declared',
    typeof version === 'string' && /^.+-opl-bash\.\d{8}\.\d+$/.test(version),
    `清单版本 ${version ?? '缺失'}，须为 <官方版本>-opl-bash.<YYYYMMDD>.<序号>`,
  )
  check(
    'version-matches-official-base',
    typeof version === 'string' && version.startsWith(`${plan.official.version}-`),
    `官方基线 ${plan.official.version}`,
  )
  const stubbed = manifest?.toolchainStubbed === true
  check(
    'toolchain-not-stubbed',
    !stubbed,
    stubbed ? '产物由 toolchain 替身生成，不可分发' : '真实工具链',
  )

  for (const required of ['cli.js', plan.launcher.windows, 'package.json', 'CANDIDATE.md'])
    check(`layout:${required}`, existsSync(join(candidateDir, required)), required)

  const declaredNode = manifest?.nodeRuntime?.path
  const expectedLauncher = launcherContent(
    declaredNode && declaredNode !== 'system-node' ? declaredNode : undefined,
  )
  const actualLauncher = existsSync(join(candidateDir, plan.launcher.windows))
    ? readFileSync(join(candidateDir, plan.launcher.windows), 'utf8')
    : ''
  check(
    'launcher-matches-declared-runtime',
    actualLauncher === expectedLauncher,
    declaredNode ?? 'system-node',
  )

  for (const file of licenseTargets())
    check(`license:${file}`, existsSync(join(candidateDir, file)), file)

  try {
    scanForCredentials(candidateDir)
    check('no-credentials', true, '候选目录内未发现凭据或官方账号数据')
  } catch (error) {
    check('no-credentials', false, error.message)
  }

  if (manifest) {
    // 清单条目必须是相对且不逃逸的路径；否则整份清单不可信。
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

    // 完整性是双向的：声明的文件要在，且候选目录里不能有清单之外的文件。
    const declared = new Set(manifest.files.map((entry) => assertRelativeInside(entry.file)))
    const actual = candidateFiles(candidateDir).filter(
      (file) => !(manifestInside && file === 'manifest.json'),
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

    const mismatched = manifest.files
      .map((entry) => {
        const file = assertRelativeInside(entry.file)
        return {
          file,
          ok:
            existsSync(join(candidateDir, file)) &&
            sha256File(join(candidateDir, file)) === entry.sha256,
        }
      })
      .filter((entry) => !entry.ok)
      .map((entry) => entry.file)
    check(
      'manifest-digests',
      mismatched.length === 0,
      mismatched.length
        ? `摘要不符：${mismatched.slice(0, 5).join(', ')}`
        : `${manifest.files.length} 个文件摘要一致`,
    )
  }

  // 外部原生/可选模块：不信任清单里的声明，直接从候选目录解析真实闭包，
  // 并拒绝落到构建树或仓库 node_modules 的包。
  const declaredExternal = manifest?.externalModules
  check(
    'external-modules-declared',
    Array.isArray(declaredExternal?.copied) &&
      plan.build.externalModules.every((name) => declaredExternal.copied.includes(name)),
    `声明 ${plan.build.externalModules.length} 个，已复制 ${declaredExternal?.copied?.length ?? 0} 个`,
  )
  const closure = verifyExternalModuleClosure(candidateDir, plan.build.externalModules)
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

  // 官方版状态只做只读探测，不执行官方启动器、不读取其账号目录内容。
  const official = {
    launcher: process.platform === 'win32' ? 'mcode.cmd' : 'mcode',
    note: '官方安装目录与登录数据未被本脚本读取或修改；实际状态由主审在安装前后自行记录。',
  }

  const capabilities = detectCapabilities(candidateDir)
  check(
    'capability-bundle-scanned',
    capabilities.bundleScanned,
    capabilities.bundleScanned ? 'chunks 已扫描' : '没有可扫描的 bundle 标记集',
  )
  check(
    'capability-markers-present',
    capabilities.markersPresent,
    JSON.stringify(capabilities.bundleMarkers),
  )

  // 报告目录：先验证真实目标，再创建；被拒绝时不能留下任何目录。
  let verifiedReportDir
  const reportDir = () =>
    (verifiedReportDir ??= assertWritableTarget(outDir, { label: '验证报告目录' }))

  // 执行闸门：先验全部通过之前不执行候选代码。
  const priorFailures = checks.filter((item) => !item.ok).map((item) => item.name)
  const smoke = priorFailures.length
    ? {
        ran: false,
        skipped: true,
        reason: `先验检查失败（${priorFailures.length} 项），未执行候选代码：${priorFailures.slice(0, 5).join(', ')}`,
      }
    : options.smoke === false
      ? { ran: false, skipped: true, reason: '本次显式跳过入口 smoke' }
      : { ...isolatedEntrySmoke(candidateDir, reportDir(), { stubbed }), skipped: false }
  if (!smoke.skipped)
    check(
      'isolated-entry-smoke',
      smoke.ran,
      smoke.ran ? `${smoke.version}（隔离数据目录）` : `未通过：${smoke.reason}`,
    )

  const report = {
    candidateDir,
    manifestPath,
    executionGate: {
      priorCheckFailures: priorFailures,
      candidateCodeExecuted: smoke.attempted === true,
      skippedReason: smoke.skipped ? smoke.reason : null,
    },
    version,
    toolchainStubbed: stubbed,
    official,
    capabilities,
    externalClosure: closure,
    isolatedEntrySmoke: smoke,
    checks,
    passed: checks.filter((item) => item.ok).length,
    failed: checks.filter((item) => !item.ok).map((item) => item.name),
    runtimeAcceptance: [
      '真实 ACP initialize 回读 _meta["minimax-code/shell"]（version=1、type=bash、同一路径、args=["-c"]）',
      '跨进程恢复后再次回读同一 Shell',
      '真实工具执行：Bash 身份、退出码、stdout/stderr、取消清理后代、超时输出',
      '两模型各自独立进程的 new/load 固定模型参数与 Shell',
    ],
    boundaries: {
      systemPathWritten: false,
      officialInstallModified: false,
      officialAccountDataCopied: false,
      distributionPublished: false,
      distributable: false,
      distributableReason: '真实构建与实机 ACP 验收未完成；本报告只覆盖静态与编排检查。',
    },
  }
  const verifiedDir = mkdirp(reportDir())
  const reportPath = join(verifiedDir, 'candidate-verification.json')
  writeJson(reportPath, report)
  return { ...report, reportPath }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      candidate: { type: 'string' },
      manifest: { type: 'string' },
      out: { type: 'string' },
      'skip-smoke': { type: 'boolean', default: false },
    },
  })
  if (!values.candidate) throw new Error('必须提供 --candidate <候选目录>。')
  const candidateDir = resolve(values.candidate)
  if (!existsSync(candidateDir)) throw new Error(`候选目录不存在：${candidateDir}`)
  const report = verifyCandidate(candidateDir, resolve(values.out || join(candidateDir, '..')), {
    manifestPath: values.manifest ? resolve(values.manifest) : undefined,
    smoke: !values['skip-smoke'],
  })
  for (const item of report.checks)
    console.log(
      `${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`,
    )
  console.log(
    `候选代码执行：${report.executionGate.candidateCodeExecuted ? '已执行 smoke' : `未执行（${report.executionGate.skippedReason}）`}`,
  )
  console.log(`报告：${report.reportPath}（${report.passed} 通过 / ${report.failed.length} 失败）`)
  if (report.failed.length) process.exit(1)
}
