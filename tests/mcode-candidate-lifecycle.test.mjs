/**
 * MiniMax Bash 候选版生命周期的聚焦检查。
 *
 * 全部离线：合成候选目录 + 注入的公开状态（环境、活动任务数）。不联网、不下载、不读真实
 * 账号/官方安装/用户配置，也不执行候选代码——`cli.js` 里放了哨兵文件写入，测试断言它从未出现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  plan,
  resolveThroughExistingAncestors,
  sha256File,
} from '../scripts/mcode-candidate/shared.mjs'
import {
  launcherContent,
  licenseTargets,
  writeManifest,
} from '../scripts/mcode-candidate/pipeline.mjs'
import {
  assertStoreRoot,
  compareVersions,
  defaultStoreRoot,
  importCandidate,
  listCandidates,
  readSelection,
  selectCandidate,
  selectionPath,
  switchToOfficial,
  verificationDir,
  verifyOnly,
} from '../scripts/mcode-candidate/lifecycle.mjs'

const lifecyclePath = fileURLToPath(
  new URL('../scripts/mcode-candidate/lifecycle.mjs', import.meta.url),
)
const V1 = '0.6.3-opl-bash.20261010.2'
const V2 = '0.6.3-opl-bash.20261011.1'
const EXTERNAL = plan.build.externalModules

const write = (path, text, encoding = 'utf8') => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, encoding)
}

/** 每个测试一个隔离基地：合成 "套件根" 与假 home，绝不落到真实用户目录。 */
function makeBase(label) {
  const base = mkdtempSync(join(tmpdir(), `mcode-lifecycle-${label}-`))
  const env = {
    ...process.env,
    USERPROFILE: join(base, 'home'),
    HOME: join(base, 'home'),
    APPDATA: join(base, 'appdata'),
    LOCALAPPDATA: join(base, 'localappdata'),
  }
  mkdirSync(join(base, 'home'), { recursive: true })
  mkdirSync(join(base, 'tmp'), { recursive: true })
  return { base, env, store: defaultStoreRoot(env) }
}

/**
 * 合成候选目录：布局、许可、bundle 标记、外部模块桩与清单，满足导入闸门的每一项。
 * `cli.js` 一旦被执行就会写下 `EXECUTED.txt`，供测试断言候选代码从未运行。
 */
function synthCandidate(root, version = V1, { bundledNode = false } = {}) {
  const markers = [
    plan.capability.acpMetaKey,
    plan.capability.acpSessionHistory.metaKey,
    plan.capability.acpSessionHistory.clientRequestIdMetaKey,
    ...plan.capability.bundleMarkers,
    ...plan.capability.acpSessionHistory.methods,
    ...plan.capability.acpSessionHistory.notifications,
  ]
  write(
    join(root, 'package.json'),
    `${JSON.stringify({ name: plan.official.packageName, version }, null, 2)}\n`,
  )
  write(
    join(root, 'cli.js'),
    `require('node:fs').writeFileSync(require('node:path').join(__dirname, 'EXECUTED.txt'), 'ran')\n`,
  )
  write(
    join(root, plan.launcher.windows),
    launcherContent(bundledNode ? 'node.exe' : undefined),
    'utf8',
  )
  if (bundledNode) write(join(root, 'node.exe'), 'synthetic runtime\n')
  write(join(root, 'CANDIDATE.md'), '# synthetic candidate\n')
  write(join(root, 'chunks/index.js'), `// ${markers.join(' ')}\n`)
  write(
    join(root, 'capability-report.json'),
    `${JSON.stringify({ bundleScanned: true }, null, 2)}\n`,
  )
  for (const file of licenseTargets()) write(join(root, file), `license: ${file}\n`)
  for (const name of EXTERNAL)
    write(
      join(root, 'node_modules', ...name.split('/'), 'package.json'),
      `${JSON.stringify({ name, version: '1.0.0' }, null, 2)}\n`,
    )
  writeManifest(root, join(root, 'manifest.json'), {
    version,
    toolchainStubbed: false,
    nodeRuntime: {
      path: bundledNode === 'declared' ? 'node.exe' : 'system-node',
      version: '24.20.0',
      sha256: null,
    },
    externalModules: {
      copied: [...EXTERNAL],
      placements: EXTERNAL.map((name) => ({
        name,
        version: '1.0.0',
        path: `node_modules/${name}`,
      })),
      closureSize: EXTERNAL.length,
      unresolved: [],
      closureVerified: false,
    },
  })
  return root
}

const setup = (label, { version = V1 } = {}) => {
  const { base, env, store } = makeBase(label)
  const source = synthCandidate(join(base, 'source', version), version)
  return { base, env, store, source, version }
}

const cleanup = (base) => rmSync(base, { recursive: true, force: true })

test('合成的候选通过只读校验，且校验过程不执行候选代码', () => {
  const { base, env, source } = setup('verify')
  try {
    const result = verifyOnly({ source, env })
    assert.equal(result.ok, true, JSON.stringify(result.failed))
    assert.equal(result.version, V1)
    assert.equal(result.applied, false)
    assert.equal(result.networkUsed, false)
    assert.equal(result.source, resolve(source))
    assert.ok(result.manifestSha256 && result.launcherSha256)
    assert.equal(existsSync(join(source, 'EXECUTED.txt')), false)
    assert.equal(
      result.checks.every((item) => item.ok),
      true,
    )
  } finally {
    cleanup(base)
  }
})

test('导入写入版本目录与校验报告，不改变选择，也不执行候选代码', () => {
  const { base, env, source, store, version } = setup('import')
  try {
    const result = importCandidate({ source, env })
    assert.equal(result.ok, true, JSON.stringify(result.failed ?? []))
    assert.equal(result.applied, true)
    assert.equal(result.selectionChanged, false)
    const destination = join(store, version)
    assert.equal(result.destination, destination)
    assert.equal(existsSync(join(destination, 'cli.js')), true)
    assert.equal(existsSync(join(destination, 'manifest.json')), true)
    assert.equal(existsSync(join(destination, 'EXECUTED.txt')), false)
    assert.equal(
      existsSync(join(verificationDir(store, version), 'import-verification.json')),
      true,
    )
    assert.equal(existsSync(selectionPath(store)), false)
    assert.equal(sha256File(join(destination, 'manifest.json')), result.manifestSha256)
    const listed = listCandidates({ env })
    assert.deepEqual(
      listed.candidates.map((item) => item.version),
      [version],
    )
    assert.equal(listed.selection, null)
  } finally {
    cleanup(base)
  }
})

test('dry-run 报告要写的步骤但一个文件都不写', () => {
  const { base, env, source, store } = setup('dry-run')
  try {
    const result = importCandidate({ source, env, select: true, activeTasks: 0, dryRun: true })
    assert.equal(result.ok, true)
    assert.equal(result.applied, false)
    assert.equal(result.selectionChanged, false)
    assert.equal(existsSync(store), false)
    assert.deepEqual(
      result.writes.map((item) => item.action),
      ['stage', 'publish', 'verification-report', 'selection'],
    )
    assert.equal(result.activeTasks.activeTasks, 0)
  } finally {
    cleanup(base)
  }
})

test('摘要、版本、能力、许可、凭据、符号链接与包闭包任一不符都拒绝导入', () => {
  const cases = {
    摘要不符: (source) => write(join(source, 'cli.js'), 'tampered\n'),
    替身工具链: (source) => {
      const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
      manifest.toolchainStubbed = true
      write(join(source, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    },
    缺少许可: (source) => rmSync(join(source, 'licenses', 'NOTICE')),
    能力标记缺失: (source) => write(join(source, 'chunks/index.js'), '// nothing declared\n'),
    凭据植入: (source) => write(join(source, 'tokens.json'), '{}\n'),
    外部模块闭包不完整: (source) =>
      rmSync(join(source, 'node_modules', 'better-sqlite3'), { recursive: true, force: true }),
  }
  for (const [label, mutate] of Object.entries(cases)) {
    const { base, env, source, store } = setup(`reject-${label}`)
    try {
      mutate(source)
      assert.equal(existsSync(join(source, 'EXECUTED.txt')), false)
      const result = importCandidate({ source, env })
      assert.equal(result.ok, false, `${label} 应被拒绝`)
      assert.ok(result.failed.length > 0, `${label} 需要失败原因`)
      assert.equal(existsSync(store), false, `${label} 不应留下 Store`)
    } finally {
      cleanup(base)
    }
  }
})

test('候选目录里的符号链接被拒绝', () => {
  const { base, env, source } = setup('symlink')
  try {
    mkdirSync(join(base, 'outside'), { recursive: true })
    write(join(base, 'outside', 'payload.js'), '// outside\n')
    symlinkSync(join(base, 'outside'), join(source, 'linked'), 'junction')
    const result = importCandidate({ source, env })
    assert.equal(result.ok, false)
    assert.ok(result.failed.includes('source-no-symlinks'), result.failed.join(','))
  } finally {
    cleanup(base)
  }
})

test('版本号不是候选后缀或官方基线时拒绝', () => {
  const { base, env, store } = setup('versions')
  try {
    const other = synthCandidate(join(base, 'other'), '0.7.0-opl-bash.20261011.1')
    const result = importCandidate({ source: other, env })
    assert.equal(result.ok, false)
    assert.ok(result.failed.includes('version-matches-official-base'), result.failed.join(','))
    const requested = importCandidate({
      source: synthCandidate(join(base, 'v1'), V1),
      env,
      version: V2,
    })
    assert.equal(requested.ok, false)
    assert.ok(requested.failed.includes('version-requested-matches'), requested.failed.join(','))
    assert.equal(existsSync(store), false)
  } finally {
    cleanup(base)
  }
})

test('切换需要注入活动任务数；有活动任务时拒绝且旧选择逐字节不变', () => {
  const { base, env, source, store, version } = setup('active')
  try {
    importCandidate({ source, env, select: true, activeTasks: 0 })
    const before = readFileSync(selectionPath(store), 'utf8')
    assert.equal(readSelection(store).selection.version, version)

    assert.throws(() => selectCandidate({ env, version }), /必须注入公开状态/)
    assert.throws(() => selectCandidate({ env, version, activeTasks: 2 }), /拒绝切换候选/)
    assert.throws(() => switchToOfficial({ env, activeTasks: 1 }), /拒绝切回官方/)
    assert.equal(readFileSync(selectionPath(store), 'utf8'), before)
  } finally {
    cleanup(base)
  }
})

test('活动任务不为零时导入并选择会在复制之前被拒，不留下版本目录', () => {
  const { base, env, source, store, version } = setup('active-import')
  try {
    assert.throws(
      () => importCandidate({ source, env, select: true, activeTasks: 1 }),
      /拒绝切换候选/,
    )
    assert.equal(existsSync(join(store, version)), false)
    assert.equal(existsSync(selectionPath(store)), false)
  } finally {
    cleanup(base)
  }
})

test('升级保留旧候选、旧选择进入历史，并原样搬运代理/模型/权限状态', () => {
  const { base, env, source, store, version } = setup('upgrade')
  try {
    importCandidate({ source, env, select: true, activeTasks: 0 })
    const preserved = {
      proxy: { mode: 'system', url: 'http://127.0.0.1:7890' },
      models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
      permissions: {
        preset: 'danger-full-access',
        sandbox: 'danger-full-access',
        approval: 'never',
      },
    }
    const seeded = readSelection(store)
    seeded.preserved = preserved
    writeFileSync(selectionPath(store), `${JSON.stringify(seeded, null, 2)}\n`)

    const next = synthCandidate(join(base, 'next'), V2)
    const result = importCandidate({
      source: next,
      env,
      upgrade: true,
      select: true,
      activeTasks: 0,
    })
    assert.equal(result.ok, true, JSON.stringify(result.failed ?? []))
    assert.equal(result.upgradeDirection, 1)

    const receipt = readSelection(store)
    assert.equal(receipt.selection.version, V2)
    assert.deepEqual(receipt.preserved, preserved)
    assert.equal(receipt.history.at(-1).version, version)
    assert.equal(existsSync(join(store, version)), true, '旧候选目录必须保留')
    assert.deepEqual(receipt.candidates.map((item) => item.version).sort(compareVersions), [
      version,
      V2,
    ])
  } finally {
    cleanup(base)
  }
})

test('升级拒绝不更高的版本，也拒绝在没有已选候选时进行', () => {
  const { base, env, source, store } = setup('upgrade-gate')
  try {
    importCandidate({ source, env, select: true, activeTasks: 0 })
    const before = readFileSync(selectionPath(store), 'utf8')
    const older = synthCandidate(join(base, 'older'), '0.6.3-opl-bash.20261009.1')
    importCandidate({ source: older, env })
    assert.throws(
      () => importCandidate({ source: older, env, upgrade: true, activeTasks: 0 }),
      /不高于当前选择/,
    )
    assert.equal(readFileSync(selectionPath(store), 'utf8'), before)

    const fresh = makeBase('upgrade-empty')
    const solo = synthCandidate(join(fresh.base, 'source'), V1)
    assert.throws(
      () => importCandidate({ source: solo, env: fresh.env, upgrade: true, activeTasks: 0 }),
      /当前没有已选择的候选版/,
    )
    assert.equal(existsSync(fresh.store), false)
    cleanup(fresh.base)
  } finally {
    cleanup(base)
  }
})

test('切回官方只改选择回执：候选保留、历史追加、代理/模型/权限不变', () => {
  const { base, env, source, store, version } = setup('official')
  try {
    const officialDir = join(base, 'official install')
    const officialLauncher = join(officialDir, process.platform === 'win32' ? 'mcode.cmd' : 'mcode')
    write(officialLauncher, '@ECHO off\r\n')
    const envWithOfficial = {
      ...env,
      PATH: `${officialDir}${process.platform === 'win32' ? ';' : ':'}${env.PATH}`,
    }

    importCandidate({ source, env: envWithOfficial, select: true, activeTasks: 0 })
    const preserved = { proxy: { mode: 'none' }, permissions: { preset: 'full-access' } }
    const seeded = readSelection(store)
    seeded.preserved = preserved
    writeFileSync(selectionPath(store), `${JSON.stringify(seeded, null, 2)}\n`)

    const result = switchToOfficial({ env: envWithOfficial, activeTasks: 0 })
    assert.equal(result.ok, true)
    assert.equal(result.applied, true)
    assert.equal(result.official.resolved, officialLauncher)
    assert.ok(result.warnings.some((warning) => warning.includes('minimax-code/shell')))

    const receipt = readSelection(store)
    assert.equal(receipt.selection.kind, 'official')
    assert.equal(receipt.selection.version, null)
    assert.deepEqual(receipt.preserved, preserved)
    assert.equal(receipt.history.at(-1).version, version)
    assert.equal(existsSync(join(store, version)), true)
    assert.equal(readFileSync(officialLauncher, 'utf8'), '@ECHO off\r\n')
  } finally {
    cleanup(base)
  }
})

test('Store 根目录的写入闸门：官方位置拒写，套件外位置要显式声明', () => {
  const { base, env } = makeBase('guard')
  try {
    assert.throws(
      () => assertStoreRoot(join(env.USERPROFILE, '.minimax-code', 'candidates'), { env }),
      /重叠/,
    )
    assert.throws(
      () => assertStoreRoot(join(env.USERPROFILE, '.dsh', 'harnesses'), { env }),
      /重叠/,
    )
    const outside = join(base, 'elsewhere', 'store')
    mkdirSync(outside, { recursive: true })
    assert.throws(() => assertStoreRoot(outside, { env }), /--allow-root/)
    assert.equal(
      assertStoreRoot(outside, { env, allowRoots: [base] }),
      resolveThroughExistingAncestors(outside),
    )
    const suiteStore = defaultStoreRoot(env)
    assert.equal(assertStoreRoot(suiteStore, { env }), resolveThroughExistingAncestors(suiteStore))
  } finally {
    cleanup(base)
  }
})

test('已存在的版本目录内容不同则拒绝；--replace 只改名保留旧目录', () => {
  const { base, env, source, store, version } = setup('replace')
  try {
    importCandidate({ source, env })
    const destination = join(store, version)
    write(join(destination, 'cli.js'), 'changed project copy\n')
    assert.throws(() => importCandidate({ source, env }), /已存在且与来源不一致/)
    const replaced = importCandidate({ source, env, replace: true })
    assert.equal(replaced.ok, true)
    const kept = readdirSync(store).filter((name) => name.startsWith(`${version}.previous-`))
    assert.equal(kept.length, 1)
    assert.equal(readFileSync(join(store, kept[0], 'cli.js'), 'utf8'), 'changed project copy\n')
    assert.equal(readFileSync(join(destination, 'cli.js'), 'utf8').includes('EXECUTED'), true)
  } finally {
    cleanup(base)
  }
})

test('选择回执损坏时拒绝覆盖', () => {
  const { base, env, source, store } = setup('corrupt')
  try {
    importCandidate({ source, env, select: true, activeTasks: 0 })
    writeFileSync(selectionPath(store), '{ not json')
    assert.throws(() => readSelection(store), /拒绝覆盖/)
    assert.throws(() => switchToOfficial({ env, activeTasks: 0 }), /拒绝覆盖/)
    assert.equal(readFileSync(selectionPath(store), 'utf8'), '{ not json')
  } finally {
    cleanup(base)
  }
})

test('启动器引用的候选内运行时必须是清单覆盖的真实文件', () => {
  const { base, env } = makeBase('bundled-runtime')
  try {
    const good = synthCandidate(join(base, 'good'), V1, { bundledNode: 'declared' })
    const okResult = verifyOnly({ source: good, env })
    assert.equal(okResult.ok, true, JSON.stringify(okResult.failed))
    assert.match(
      okResult.checks.find((item) => item.name === 'launcher-runtime-resolvable').detail,
      /与清单声明的运行时一致/,
    )

    // 清单声明 system-node，但启动器引用候选内运行时：只要该文件被清单覆盖就接受。
    const bundled = synthCandidate(join(base, 'bundled'), V1, { bundledNode: 'undeclared' })
    const bundledResult = verifyOnly({ source: bundled, env })
    assert.equal(bundledResult.ok, true, JSON.stringify(bundledResult.failed))
    assert.match(
      bundledResult.checks.find((item) => item.name === 'launcher-runtime-resolvable').detail,
      /候选内运行时已被清单覆盖/,
    )

    // 运行时存在但没有清单覆盖：不能被当成合法分发物。
    const uncovered = synthCandidate(join(base, 'uncovered'), V1)
    write(join(uncovered, 'node.exe'), 'synthetic runtime\n')
    write(join(uncovered, plan.launcher.windows), launcherContent('node.exe'), 'utf8')
    const uncoveredResult = verifyOnly({ source: uncovered, env })
    assert.equal(uncoveredResult.ok, false)
    assert.ok(uncoveredResult.failed.includes('launcher-runtime-resolvable'))
    assert.match(
      uncoveredResult.checks.find((item) => item.name === 'launcher-runtime-resolvable').detail,
      /未被清单摘要覆盖/,
    )

    // 上跳出候选目录的引用必须被拒绝。
    const escaping = synthCandidate(join(base, 'escaping'), V1)
    write(join(escaping, plan.launcher.windows), launcherContent('..\\node.exe'), 'utf8')
    const escapingResult = verifyOnly({ source: escaping, env })
    assert.equal(escapingResult.ok, false)
    assert.match(
      escapingResult.checks.find((item) => item.name === 'launcher-runtime-resolvable').detail,
      /逃出候选目录/,
    )
  } finally {
    cleanup(base)
  }
})

test('诊断如实声明回执未接线、活动数由调用方注入、能力标记不等于运行时验收', () => {
  const { base, env, source, version } = setup('diagnostics')
  try {
    const imported = importCandidate({ source, env, select: true, activeTasks: 0 })
    assert.equal(imported.ok, true, JSON.stringify(imported.failed ?? []))
    assert.equal(imported.integration.wiredByLifecycle, false)
    assert.equal(imported.integration.receiptOnly, true)
    assert.match(imported.integration.publicInterface, /save-catalog/)
    assert.ok(imported.warnings.some((warning) => warning.includes('审计回执')))
    assert.ok(imported.warnings.some((warning) => warning.includes('save-catalog')))
    assert.equal(imported.activeTasks.injected, true)
    assert.match(imported.activeTasks.note, /不探活/)

    const selected = selectCandidate({ env, version, activeTasks: 0 })
    assert.equal(selected.integration.receiptOnly, true)
    assert.ok(selected.warnings.some((warning) => warning.includes('不会改变 MiniMax 组合')))

    const official = switchToOfficial({ env, activeTasks: 0 })
    assert.ok(official.warnings.some((warning) => warning.includes('save-catalog')))
    assert.ok(official.warnings.some((warning) => warning.includes('minimax-code/shell')))

    const listed = listCandidates({ env })
    assert.equal(listed.integration.wiredByLifecycle, false)

    const verified = verifyOnly({ source, env })
    assert.equal(verified.runtimeValidation.verifiedByThisScript, false)
    assert.match(verified.runtimeValidation.reason, /不执行候选代码/)
  } finally {
    cleanup(base)
  }
})

/** 重算清单里每个文件的摘要与字节数，用来证明拒绝的原因是内容/身份而不是摘要本身。 */
function refreshManifest(source) {
  const path = join(source, 'manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  for (const entry of manifest.files) {
    const file = join(source, entry.file)
    entry.sha256 = sha256File(file)
    entry.bytes = readFileSync(file).length
  }
  write(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

test('包内身份必须自洽：改写 package.json 并重算摘要仍被拒绝', () => {
  const { base, env, store } = setup('package-identity')
  try {
    // 版本被改成别的值，摘要全部重算一致——旧实现只看 manifest.version 会放行。
    const wrongVersion = synthCandidate(join(base, 'wrong-version'), V1)
    write(
      join(wrongVersion, 'package.json'),
      `${JSON.stringify({ name: plan.official.packageName, version: '0.0.0-wrong' }, null, 2)}\n`,
    )
    refreshManifest(wrongVersion)
    const versionResult = verifyOnly({ source: wrongVersion, env })
    assert.equal(versionResult.ok, false)
    assert.ok(
      versionResult.failed.includes('candidate-package-identity'),
      versionResult.failed.join(','),
    )

    // 包名不是官方构建链写出的分发名，同样拒绝。
    const wrongName = synthCandidate(join(base, 'wrong-name'), V1)
    write(
      join(wrongName, 'package.json'),
      `${JSON.stringify({ name: 'not-minimax', version: V1 }, null, 2)}\n`,
    )
    refreshManifest(wrongName)
    const nameResult = importCandidate({ source: wrongName, env })
    assert.equal(nameResult.ok, false)
    assert.ok(nameResult.failed.includes('candidate-package-identity'), nameResult.failed.join(','))

    assert.equal(existsSync(store), false)
  } finally {
    cleanup(base)
  }
})

test('清单不允许重复路径，字节数声明也要与磁盘一致', () => {
  const { base, env } = setup('manifest-shape')
  try {
    const duplicated = synthCandidate(join(base, 'duplicated'), V1)
    const manifest = JSON.parse(readFileSync(join(duplicated, 'manifest.json'), 'utf8'))
    const first = manifest.files[0]
    manifest.files.push({ ...first })
    write(join(duplicated, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const duplicateResult = verifyOnly({ source: duplicated, env })
    assert.equal(duplicateResult.ok, false)
    assert.ok(
      duplicateResult.failed.includes('manifest-unique-paths'),
      duplicateResult.failed.join(','),
    )

    // sha256 重算了但字节数留着旧值：必须按字节数不符拒绝。
    const staleBytes = synthCandidate(join(base, 'stale-bytes'), V1)
    write(join(staleBytes, 'CANDIDATE.md'), '# synthetic candidate changed\n')
    const stale = JSON.parse(readFileSync(join(staleBytes, 'manifest.json'), 'utf8'))
    const entry = stale.files.find((item) => item.file === 'CANDIDATE.md')
    entry.sha256 = sha256File(join(staleBytes, 'CANDIDATE.md'))
    write(join(staleBytes, 'manifest.json'), `${JSON.stringify(stale, null, 2)}\n`)
    const bytesResult = verifyOnly({ source: staleBytes, env })
    assert.equal(bytesResult.ok, false)
    assert.ok(bytesResult.failed.includes('manifest-digests'), bytesResult.failed.join(','))
  } finally {
    cleanup(base)
  }
})

test('派生输出路径的 junction 逃逸在写入之前被拒，且旧状态不变', () => {
  const { base, env, store, source, version } = setup('derived-junction')
  try {
    mkdirSync(store, { recursive: true })
    // 1) Store 内的 verification/ 被建成指向 Store 之外的 junction。
    const outsideReports = join(base, 'outside-store')
    mkdirSync(outsideReports, { recursive: true })
    symlinkSync(outsideReports, join(store, 'verification'), 'junction')
    assert.throws(() => importCandidate({ source, env }), /不在候选 Store/)
    assert.equal(existsSync(join(outsideReports, version)), false)
    assert.equal(existsSync(join(store, version)), false)
    assert.equal(existsSync(selectionPath(store)), false)

    // 2) 版本目录本身是指向 Store 之外的 junction。
    rmSync(join(store, 'verification'), { recursive: true, force: true })
    const outsideVersion = join(base, 'outside-version')
    mkdirSync(outsideVersion, { recursive: true })
    symlinkSync(outsideVersion, join(store, version), 'junction')
    assert.throws(() => importCandidate({ source, env }), /不在候选 Store/)
    assert.equal(existsSync(join(outsideVersion, 'manifest.json')), false)

    // 3) 回执路径是指向 Store 之外的 junction。
    rmSync(join(store, version), { recursive: true, force: true })
    symlinkSync(outsideReports, join(store, 'selection.json'), 'junction')
    assert.throws(() => switchToOfficial({ env, activeTasks: 0 }), /不在候选 Store/)
  } finally {
    cleanup(base)
  }
})

test('来源目录别名到 Store 内部时拒绝自我导入', () => {
  const { base, env, store, source } = setup('self-import')
  try {
    mkdirSync(store, { recursive: true })
    const alias = join(store, 'incoming')
    cpSync(source, alias, { recursive: true })
    assert.throws(() => importCandidate({ source: alias, env }), /拒绝自我导入/)
    assert.equal(existsSync(selectionPath(store)), false)
  } finally {
    cleanup(base)
  }
})

test('启动器必须是完整已知模板：额外命令、额外行或改写结尾都被拒绝', () => {
  const { base, env } = setup('launcher-grammar')
  try {
    const injected = synthCandidate(join(base, 'injected'), V1)
    // 合法运行时引用 + 一条额外动作；摘要重算一致，只可能被语法闸门发现。
    write(
      join(injected, plan.launcher.windows),
      [
        '@ECHO off',
        'REM MiniMax Bash candidate launcher. Not an official MiniMax release.',
        'echo unexpected-action',
        '"%~dp0node.exe" "%~dp0cli.js" %*',
        'EXIT /B %ERRORLEVEL%',
        '',
      ].join('\r\n'),
      'utf8',
    )
    refreshManifest(injected)
    const injectedResult = verifyOnly({ source: injected, env })
    assert.equal(injectedResult.ok, false)
    assert.ok(injectedResult.failed.includes('launcher-grammar'), injectedResult.failed.join(','))

    const chained = synthCandidate(join(base, 'chained'), V1)
    write(
      join(chained, plan.launcher.windows),
      [
        '@ECHO off',
        'REM MiniMax Bash candidate launcher. Not an official MiniMax release.',
        'node "%~dp0cli.js" %* & del /q "%~dp0CANDIDATE.md"',
        'EXIT /B %ERRORLEVEL%',
        '',
      ].join('\r\n'),
      'utf8',
    )
    refreshManifest(chained)
    const chainedResult = verifyOnly({ source: chained, env })
    assert.equal(chainedResult.ok, false)
    assert.ok(chainedResult.failed.includes('launcher-grammar'), chainedResult.failed.join(','))

    const truncated = synthCandidate(join(base, 'truncated'), V1)
    write(
      join(truncated, plan.launcher.windows),
      ['@ECHO off', 'node "%~dp0cli.js" %*', ''].join('\r\n'),
      'utf8',
    )
    refreshManifest(truncated)
    const truncatedResult = verifyOnly({ source: truncated, env })
    assert.equal(truncatedResult.ok, false)
    assert.ok(truncatedResult.failed.includes('launcher-grammar'), truncatedResult.failed.join(','))
  } finally {
    cleanup(base)
  }
})

test('启动器运行时必须与清单声明一致，不能凭空出现未声明的 node', () => {
  const { base, env } = setup('launcher-runtime-consistency')
  try {
    // 清单声明绝对运行时，启动器却改成候选内 node.exe：两者必须一致。
    const declaredAbsolute = synthCandidate(join(base, 'declared-absolute'), V1)
    const manifestPath = join(declaredAbsolute, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.nodeRuntime = { path: 'C:/toolchain/node.exe', version: '24.20.0', sha256: null }
    write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    write(join(declaredAbsolute, 'node.exe'), 'synthetic runtime\n')
    write(join(declaredAbsolute, plan.launcher.windows), launcherContent('node.exe'), 'utf8')
    refreshManifest(declaredAbsolute)
    const absoluteResult = verifyOnly({ source: declaredAbsolute, env })
    assert.equal(absoluteResult.ok, false)
    assert.ok(
      absoluteResult.failed.includes('launcher-runtime-resolvable'),
      absoluteResult.failed.join(','),
    )

    // 清单声明 system-node，启动器却写死外部绝对路径。
    const declaredPortable = synthCandidate(join(base, 'declared-portable'), V1)
    write(
      join(declaredPortable, plan.launcher.windows),
      launcherContent('C:/Program Files/nodejs/node.exe'),
      'utf8',
    )
    refreshManifest(declaredPortable)
    const portableResult = verifyOnly({ source: declaredPortable, env })
    assert.equal(portableResult.ok, false)
    assert.ok(
      portableResult.failed.includes('launcher-runtime-resolvable'),
      portableResult.failed.join(','),
    )
  } finally {
    cleanup(base)
  }
})

test('--replace 拒绝替换当前已选择的版本，回执与目录保持不变', () => {
  const { base, env, source, store, version } = setup('replace-selected')
  try {
    importCandidate({ source, env, select: true, activeTasks: 0 })
    const before = readFileSync(selectionPath(store), 'utf8')
    write(join(store, version, 'CANDIDATE.md'), '# changed after selection\n')
    assert.throws(
      () => importCandidate({ source, env, replace: true }),
      /不能 --replace 当前已选择的候选版本/,
    )
    assert.equal(readFileSync(selectionPath(store), 'utf8'), before)
    assert.equal(
      readFileSync(join(store, version, 'CANDIDATE.md'), 'utf8'),
      '# changed after selection\n',
    )
    assert.equal(
      readdirSync(store).some((name) => name.startsWith(`${version}.previous-`)),
      false,
    )
  } finally {
    cleanup(base)
  }
})

test('复制/发布阶段的失败会恢复原版本目录，并把被拒产物保留在 Store 内', () => {
  const { base, env, source, store, version } = setup('rollback-publish')
  try {
    // V1 是被选择的版本，V3 是这次要替换的非选中版本。
    importCandidate({ source, env, select: true, activeTasks: 0 })
    const receiptBefore = readFileSync(selectionPath(store), 'utf8')
    const v3 = '0.6.3-opl-bash.20261012.1'
    importCandidate({ source: synthCandidate(join(base, 'v3'), v3), env })
    write(join(store, v3, 'CANDIDATE.md'), '# original v3 content\n')

    // 注入：把报告路径变成同名文件，让发布之后的 mkdirp/写报告必然失败。
    rmSync(verificationDir(store, v3), { recursive: true, force: true })
    write(join(store, 'verification', v3), 'not a directory\n')

    const result = importCandidate({
      source: synthCandidate(join(base, 'v3-next'), v3),
      env,
      replace: true,
    })
    assert.equal(result.ok, false)
    assert.equal(result.applied, false)
    assert.equal(result.restored, true, JSON.stringify(result))
    assert.ok(result.error)
    // 原版本目录已经改回原位，内容仍是替换前那份。
    assert.equal(readFileSync(join(store, v3, 'CANDIDATE.md'), 'utf8'), '# original v3 content\n')
    assert.equal(
      readdirSync(store).some((name) => name.startsWith(`${v3}.previous-`)),
      false,
    )
    // 被拒的候选产物保留在 Store 内，原目录没有被删除。
    assert.equal(
      readdirSync(store).some((name) => name.startsWith(`${v3}.failed-`)),
      true,
    )
    assert.equal(existsSync(join(store, version)), true)
    assert.equal(readFileSync(selectionPath(store), 'utf8'), receiptBefore)
  } finally {
    cleanup(base)
  }
})

test('写回执阶段的失败同样恢复原状态，不谎报 applied=false', (t) => {
  const { base, env, source, store, version } = setup('rollback-receipt')
  try {
    importCandidate({ source, env, select: true, activeTasks: 0 })
    const receiptBefore = readFileSync(selectionPath(store), 'utf8')
    const v2 = '0.6.3-opl-bash.20261012.2'
    // POSIX rename 可以替换只读文件；定点注入回执发布失败，保留真实导入与回切操作。
    const originalRename = fs.renameSync
    let receiptFailures = 0
    t.mock.method(fs, 'renameSync', (source, destination) => {
      if (destination === selectionPath(store)) {
        receiptFailures++
        throw Object.assign(new Error('Receipt publication denied'), { code: 'EACCES' })
      }
      return originalRename(source, destination)
    })
    syncBuiltinESMExports()
    const result = importCandidate({
      source: synthCandidate(join(base, 'v2'), v2),
      env,
      select: true,
      activeTasks: 0,
    })
    assert.equal(receiptFailures, 1)
    assert.equal(result.ok, false)
    assert.equal(result.applied, false)
    assert.equal(result.restored, true, JSON.stringify(result))
    assert.equal(result.selectionChanged, false)
    assert.ok(result.error)
    // 新版本没有留在目标位置，而是作为失败产物保留；旧选择与回执逐字节不变。
    assert.equal(existsSync(join(store, v2)), false)
    assert.equal(
      readdirSync(store).some((name) => name.startsWith(`${v2}.failed-`)),
      true,
    )
    assert.equal(existsSync(join(store, version)), true)
    assert.equal(readFileSync(selectionPath(store), 'utf8'), receiptBefore)
    assert.equal(readSelection(store).selection.version, version)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    cleanup(base)
  }
})

test('校验报告替换目录项，保留硬链接指向的 Store 外文件', () => {
  const { base, env, source, store, version } = setup('report-hardlink')
  try {
    const report = join(verificationDir(store, version), 'import-verification.json')
    mkdirSync(dirname(report), { recursive: true })
    const outside = join(base, 'outside-report.json')
    write(outside, 'preserve-canary\n')
    linkSync(outside, report)
    const result = importCandidate({ source, env })
    assert.equal(result.ok, true)
    assert.equal(readFileSync(outside, 'utf8'), 'preserve-canary\n')
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).passed, true)
  } finally {
    cleanup(base)
  }
})

test('命令行入口：verify 输出 JSON 并以退出码表达成败', () => {
  const { base, env, source } = setup('cli')
  try {
    const runCli = (args) =>
      execFileSync(process.execPath, [lifecyclePath, ...args], {
        encoding: 'utf8',
        env: { ...env, TEMP: join(base, 'tmp'), TMP: join(base, 'tmp') },
      })
    const okOut = JSON.parse(runCli(['verify', '--source', source, '--json']))
    assert.equal(okOut.ok, true)
    assert.equal(okOut.command, 'verify')

    write(join(source, 'cli.js'), 'tampered\n')
    let failed
    try {
      runCli(['verify', '--source', source, '--json'])
    } catch (error) {
      failed = JSON.parse(String(error.stdout))
    }
    assert.equal(failed.ok, false)
    assert.ok(failed.failed.includes('manifest-digests'), failed.failed.join(','))
  } finally {
    cleanup(base)
  }
})
