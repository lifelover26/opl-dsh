/** Prepare an explicit enhancement update, then consume it before Desktop starts. */
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  open,
  unlink,
  rm,
  rename,
  lstat,
  readdir,
} from 'node:fs/promises'
import { basename, join, dirname, resolve, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { inflateRawSync, crc32 } from 'node:zlib'
import { installationPaths } from './installation-paths.mjs'
import {
  acquireSuiteMaintenance,
  assertUpdateTransaction,
  readUpdateTransaction,
} from './update-transaction.mjs'
import {
  checkRelease,
  newer,
  downloadReleaseAsset,
  validateReleaseMetadata,
  releaseForInstallation,
} from './update-discovery.mjs'

export { checkRelease, newer } from './update-discovery.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/u
const pendingName = 'enhancement-pending.json'
const stagePattern = /^prepared-[a-f0-9]{64}-[a-zA-Z0-9]+$/u
const maxExpandedSize = 256 * 1024 * 1024
const maxPendingSize = 1024 * 1024

/** An explicit candidate installation remains identifiable until the user replaces it. */
export function isLocalCandidateInstall(artifact, flags) {
  return flags.includes('--local-candidate') || artifact.sourceDirty === true
}

function safePath(path) {
  if (typeof path !== 'string' || !path || path.includes(String.fromCharCode(92)))
    throw Error('增强包路径无效')
  for (const part of path.split('/')) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[:\x00-\x1f<>"|?*]/u.test(part) ||
      /[. ]$/u.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    )
      throw Error('增强包路径无效')
  }
  return path
}

async function directory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('更新目录不是普通目录')
}

async function regularFile(path, limit = maxExpandedSize) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw Error('更新文件类型或大小无效')
  return readFile(path)
}

async function readOptional(path, limit) {
  try {
    return await regularFile(path, limit)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('更新进程标识无效')
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function lockUpdate(root, options) {
  const unlock = await lockEnhancementUpdate(root)
  try {
    const access = await acquireSuiteMaintenance(root, options)
    return async () => {
      try {
        await unlock()
      } finally {
        await access.release()
      }
    }
  } catch (error) {
    await unlock()
    throw error
  }
}

async function lockEnhancementUpdate(root) {
  await directory(root)
  const path = join(root, 'enhancement-update.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid }))
      return async () => {
        await handle.close()
        await unlink(path)
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const bytes = await regularFile(path, 1024)
      const record = JSON.parse(bytes.toString('utf8'))
      const pid = typeof record === 'number' ? record : record.pid
      if (alive(pid)) throw Error('另一项增强更新正在进行')
      // Serialize stale-lock removal and reread the owner after acquiring it.
      const recoveryPath = `${path}.recovery`
      const recovery = await open(recoveryPath, 'wx', 0o600)
      try {
        const latest = await readOptional(path, 1024)
        if (latest !== null) {
          const owner = JSON.parse(latest.toString('utf8'))
          if (alive(typeof owner === 'number' ? owner : owner.pid))
            throw Error('另一项增强更新正在进行')
          await unlink(path)
        }
      } finally {
        await recovery.close()
        await unlink(recoveryPath)
      }
    }
  }
  throw Error('无法取得增强更新锁')
}

async function installed(root, application) {
  const bytes = await regularFile(join(root, 'installation.json'), 128 * 1024)
  const current = installationPaths(JSON.parse(bytes.toString('utf8')), { suiteRoot: root })
  if (
    typeof current.release !== 'string' ||
    !isAbsolute(current.release) ||
    typeof current.app !== 'string' ||
    !isAbsolute(current.app) ||
    resolve(application) !== resolve(current.app) ||
    typeof current.skillDir !== 'string' ||
    !isAbsolute(current.skillDir) ||
    !hashPattern.test(current.suiteSha256) ||
    !hashPattern.test(current.enhancementSha256) ||
    resolve(current.release) !== resolve(root, 'releases', current.suiteSha256)
  )
    throw Error('更新路径与原安装不匹配')
  await directory(current.release)
  return { bytes, current }
}

/** Read the selected official application's version without launching its Desktop UI. */
export function readOfficialVersion(application) {
  const executable =
    process.platform === 'win32'
      ? join(application, 'DeepSeek Harness.exe')
      : join(application, 'Contents/MacOS/DeepSeek Harness')
  const resources = process.platform === 'win32' ? 'resources' : 'Contents/Resources'
  const manifest = join(application, resources, 'app.asar/package.json')
  const result = spawnSync(
    executable,
    ['-e', `process.stdout.write(require(${JSON.stringify(manifest)}).version)`],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_USE_SYSTEM_CA: '1' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 4096,
    },
  )
  const version = result.stdout?.trim()
  if (
    result.error ||
    result.status !== 0 ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? '')
  )
    throw Error('无法确认官方桌面版本')
  return version
}

// Release packaging emits ordinary, single-disk ZIPs. Parse those entries in memory
// so links, aliases and expansion limits are checked before any file is written.
function unpackPayload(bytes) {
  if (bytes.length < 22) throw Error('增强 ZIP 无效')
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset
      break
    }
  }
  if (end < 0) throw Error('增强 ZIP 目录缺失')
  const count = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12),
    centralStart = bytes.readUInt32LE(end + 16)
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    count === 0 ||
    count > 4096 ||
    centralStart + centralSize !== end
  )
    throw Error('增强 ZIP 目录无效')
  const entries = new Map(),
    seen = new Set(),
    ranges = []
  let cursor = centralStart,
    total = 0
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw Error('增强 ZIP 条目无效')
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10)
    const checksum = bytes.readUInt32LE(cursor + 16),
      size = bytes.readUInt32LE(cursor + 24)
    const compressed = bytes.readUInt32LE(cursor + 20),
      length = bytes.readUInt16LE(cursor + 28)
    const local = bytes.readUInt32LE(cursor + 42)
    const next =
      cursor + 46 + length + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32)
    if (
      next > end ||
      bytes.readUInt16LE(cursor + 34) !== 0 ||
      (flags & ~0x808) !== 0 ||
      ![0, 8].includes(method)
    )
      throw Error('增强 ZIP 压缩格式无效')
    const encodedName = bytes.subarray(cursor + 46, cursor + 46 + length)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(encodedName)
    const isDirectory = name.endsWith('/'),
      path = safePath(isDirectory ? name.slice(0, -1) : name)
    const key = path.toLowerCase(),
      attributes = bytes.readUInt32LE(cursor + 38),
      type = (attributes >>> 16) & 0xf000
    if (
      seen.has(key) ||
      ![0, isDirectory ? 0x4000 : 0x8000].includes(type) ||
      (attributes & 0x400) !== 0
    )
      throw Error('增强 ZIP 包含重复路径、链接或特殊文件')
    seen.add(key)
    total += size
    if (
      total > maxExpandedSize ||
      local + 30 > centralStart ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      throw Error('增强 ZIP 展开大小或本地条目无效')
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const localName = bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26))
    if (
      start + compressed > centralStart ||
      !encodedName.equals(localName) ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      (!(flags & 8) &&
        (bytes.readUInt32LE(local + 14) !== checksum ||
          bytes.readUInt32LE(local + 18) !== compressed ||
          bytes.readUInt32LE(local + 22) !== size))
    )
      throw Error('增强 ZIP 条目不一致')
    ranges.push([local, start + compressed])
    const data = bytes.subarray(start, start + compressed)
    const content =
      method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(1, size) })
    if (content.length !== size || crc32(content) !== checksum || (isDirectory && size !== 0))
      throw Error('增强 ZIP 内容校验失败')
    if (!isDirectory) entries.set(path, content)
    cursor = next
  }
  ranges.sort((a, b) => a[0] - b[0])
  if (cursor !== end || ranges.some((range, i) => i > 0 && ranges[i - 1][1] > range[0]))
    throw Error('增强 ZIP 条目重叠')
  return entries
}

function artifactManifest(bytes, expected) {
  const artifact = JSON.parse(bytes.toString('utf8'))
  const version = artifact.enhancementVersion ?? artifact.version
  if (
    !artifact.payloadFiles ||
    typeof artifact.payloadFiles !== 'object' ||
    Array.isArray(artifact.payloadFiles) ||
    !hashPattern.test(artifact.suiteSha256) ||
    artifact.suiteSha256 !== digest(JSON.stringify(artifact.payloadFiles)) ||
    !/^opl-dsh-enhancements-[a-zA-Z0-9.-]+\.tgz$/u.test(artifact.name) ||
    !hashPattern.test(artifact.sha256) ||
    artifact.payloadFiles[artifact.name] !== artifact.sha256 ||
    (expected &&
      (version !== expected.version || artifact.officialVersion !== expected.officialVersion))
  )
    throw Error('增强安装清单无效')
  const seen = new Set()
  for (const [path, hash] of Object.entries(artifact.payloadFiles)) {
    safePath(path)
    if (!hashPattern.test(hash) || path === 'artifact.json' || seen.has(path.toLowerCase()))
      throw Error('增强文件摘要或路径无效')
    seen.add(path.toLowerCase())
  }
  for (const required of [
    'install.mjs',
    'profile.cjs',
    'model-plugins.cjs',
    'kimi-cu.mjs',
    'setup.mjs',
    'update.mjs',
    'skill-install.mjs',
    'migrate.cjs',
    artifact.name,
  ]) {
    if (!Object.hasOwn(artifact.payloadFiles, required)) throw Error('增强安装文件缺失')
  }
  return artifact
}

function verifyEntries(entries, expected) {
  const manifestBytes = entries.get('artifact.json')
  if (!manifestBytes || manifestBytes.length > 128 * 1024) throw Error('增强安装清单缺失或过大')
  const artifact = artifactManifest(manifestBytes, expected)
  // Older packages include this declaration alongside the hashed runtime files.
  const allowed = new Set([
    'artifact.json',
    'installation-paths.d.mts',
    ...Object.keys(artifact.payloadFiles),
  ])
  for (const path of entries.keys()) if (!allowed.has(path)) throw Error('增强包包含清单以外的文件')
  for (const [path, hash] of Object.entries(artifact.payloadFiles)) {
    const bytes = entries.get(path)
    if (!bytes || digest(bytes) !== hash) throw Error('增强文件 SHA-256 校验失败')
  }
  return artifact
}

async function verifyDirectory(path, expected) {
  const entries = new Map()
  let total = 0
  async function visit(current, prefix = '') {
    await directory(current)
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      safePath(relative)
      if (entry.isDirectory()) await visit(join(current, entry.name), relative)
      else {
        const bytes = await regularFile(join(current, entry.name))
        total += bytes.length
        if (total > maxExpandedSize || entries.size >= 4096) throw Error('增强目录超过大小上限')
        entries.set(relative, bytes)
      }
    }
  }
  await visit(path)
  return {
    artifact: verifyEntries(entries, expected),
    artifactSha256: digest(entries.get('artifact.json')),
  }
}

function validatePending(plan) {
  if (
    !plan ||
    plan.schemaVersion !== 1 ||
    !stagePattern.test(plan.stage) ||
    !hashPattern.test(plan.installationSha256) ||
    !hashPattern.test(plan.originalArtifactSha256) ||
    !hashPattern.test(plan.artifactSha256) ||
    !hashPattern.test(plan.suiteSha256) ||
    typeof plan.preparedAt !== 'string' ||
    !Number.isFinite(Date.parse(plan.preparedAt)) ||
    typeof plan.application !== 'string' ||
    !isAbsolute(plan.application)
  )
    throw Error('待安装更新计划无效')
  const metadata = validateReleaseMetadata(plan.metadata)
  if (
    plan.version !== metadata.manifest.enhancement.version ||
    plan.officialVersion !== metadata.manifest.official.version
  )
    throw Error('待安装更新版本不符')
  return { ...plan, metadata }
}

/** Return the explicit pending version; malformed plans remain available for diagnosis. */
export async function readPreparedUpdate(root) {
  const bytes = await readOptional(join(root, pendingName), maxPendingSize)
  if (bytes === null) return null
  const plan = validatePending(JSON.parse(bytes.toString('utf8')))
  return { version: plan.version, preparedAt: plan.preparedAt }
}

/** Download and verify a newer compatible release without executing its installer. */
export async function prepareUpdate(root, application, { signal, expectedVersion } = {}) {
  const unlock = await lockUpdate(root)
  let stage
  try {
    signal?.throwIfAborted()
    const { current, bytes: installationBytes } = await installed(root, application)
    const officialVersion = readOfficialVersion(application)
    if (current.officialVersion !== officialVersion)
      throw Error('官方桌面与安装回执版本不符，请重新安装完整套件')
    const { release, metadata } = await checkRelease(
      { ...current, officialVersion, platform: process.platform, arch: process.arch },
      { signal },
    )
    if (!release) throw Error('没有更新的稳定增强版本')
    if (expectedVersion !== undefined && release.version !== expectedVersion)
      throw Error('稳定发布版本已改变，请重新检查')
    if (release.compatibility !== 'enhancement') throw Error('此版本需要安装完整套件')
    const previous = await verifyDirectory(current.release, {
      version: current.suiteVersion,
      officialVersion,
    })
    if (previous.artifact.updateProtocolVersion !== 1)
      throw Error('原安装需要重新安装完整套件以启用安全更新')
    if (
      current.suiteSha256 !== previous.artifact.suiteSha256 ||
      current.enhancementSha256 !== previous.artifact.sha256
    )
      throw Error('原安装文件与安装回执不符')
    const archive = await downloadReleaseAsset(metadata.asset, { signal })
    const entries = unpackPayload(archive)
    const artifact = verifyEntries(entries, release)
    if (artifact.updateProtocolVersion !== 1)
      throw Error('增强包不支持安全更新协议，请安装完整套件')
    const updates = join(root, 'updates')
    await mkdir(updates, { recursive: true, mode: 0o700 })
    await directory(updates)
    stage = await mkdtemp(join(updates, `prepared-${digest(archive)}-`))
    const payload = join(stage, 'payload')
    await mkdir(payload, { mode: 0o700 })
    for (const [path, bytes] of entries) {
      await mkdir(dirname(join(payload, path)), { recursive: true, mode: 0o700 })
      await writeFile(join(payload, path), bytes, { mode: 0o600, flag: 'wx' })
    }
    await writeFile(join(stage, 'payload.zip'), archive, { mode: 0o600, flag: 'wx' })
    signal?.throwIfAborted()
    if (
      digest((await installed(root, application)).bytes) !== digest(installationBytes) ||
      readOfficialVersion(application) !== officialVersion
    )
      throw Error('下载期间原安装已改变')
    const preparedAt = new Date().toISOString()
    await atomicJson(join(root, pendingName), {
      schemaVersion: 1,
      version: release.version,
      officialVersion,
      preparedAt,
      application: resolve(application),
      stage: basename(stage),
      installationSha256: digest(installationBytes),
      originalArtifactSha256: previous.artifactSha256,
      artifactSha256: digest(entries.get('artifact.json')),
      suiteSha256: artifact.suiteSha256,
      metadata,
    })
    stage = undefined
    return { version: release.version, preparedAt, release }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    await unlock()
  }
}

/** Cancel only the pending request; retain staged files and installed releases. */
export async function cancelPreparedUpdate(root) {
  const unlock = await lockUpdate(root)
  try {
    await unlink(join(root, pendingName)).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  } finally {
    await unlock()
  }
}

async function profilesStopped(current) {
  const profiles = join(current.profileHome, 'profiles')
  let names
  try {
    await directory(profiles)
    names = await readdir(profiles, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of names) {
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) throw Error('无法确认链接 profile 的运行状态')
      continue
    }
    const bytes = await readOptional(join(profiles, entry.name, 'control.json'), 128 * 1024)
    if (bytes !== null && alive(JSON.parse(bytes.toString('utf8')).pid))
      throw Error('已有 profile 正在运行')
  }
}

function runInstaller(payload, application, root, current, candidate = false) {
  const executable =
    process.platform === 'win32'
      ? join(application, 'DeepSeek Harness.exe')
      : join(application, 'Contents/MacOS/DeepSeek Harness')
  const result = spawnSync(
    executable,
    [
      join(payload, 'install.mjs'),
      application,
      root,
      payload,
      '--no-launch',
      '--update-if-stopped',
      ...(candidate ? ['--local-candidate'] : []),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_USE_SYSTEM_CA: '1',
        OPL_DSH_HOME: current.profileHome,
        OPL_CODEX_HOME: dirname(dirname(current.skillDir)),
      },
      stdio: 'ignore',
      windowsHide: true,
      timeout: 180000,
    },
  )
  if (result.error || result.status !== 0) throw Error('增强安装失败')
}

async function confirmInstalled(root, application, expected, original) {
  const { current } = await installed(root, application)
  if (
    current.suiteVersion !== (expected.enhancementVersion ?? expected.version) ||
    current.officialVersion !== expected.officialVersion ||
    current.suiteSha256 !== expected.suiteSha256 ||
    current.enhancementSha256 !== expected.sha256 ||
    current.profileHome !== original.profileHome ||
    resolve(current.skillDir) !== resolve(original.skillDir) ||
    resolve(current.release) !== resolve(root, 'releases', expected.suiteSha256)
  )
    throw Error('增强安装结果未确认')
  await verifyDirectory(current.release, {
    version: current.suiteVersion,
    officialVersion: current.officialVersion,
  })
}

/** Apply only a prepared plan, offline, before any profile starts; preserve failures for retry. */
export async function refreshEnhancements(root, application, { transaction } = {}) {
  let unlock
  let rollback
  try {
    if (transaction) await assertUpdateTransaction(root, transaction)
    if ((await readOptional(join(root, pendingName), maxPendingSize)) === null) return
    unlock = await lockUpdate(root, { transaction, allowLaunch: true })
    const pendingBytes = await readOptional(join(root, pendingName), maxPendingSize)
    if (pendingBytes === null) return
    if (!transaction) {
      const previous = await readUpdateTransaction(root)
      if (
        previous &&
        ['failed', 'cancelled', 'succeeded'].includes(previous.stage) &&
        previous.targetPendingSha256 === digest(pendingBytes)
      )
        throw Error('此更新计划已有处理结果，请取消后重新准备')
    }
    const plan = validatePending(JSON.parse(pendingBytes.toString('utf8')))
    const { current, bytes: installationBytes } = await installed(root, application)
    if (
      plan.application !== resolve(application) ||
      plan.installationSha256 !== digest(installationBytes)
    )
      throw Error('待安装更新与当前安装不匹配')
    if (
      !newer(plan.version, current.suiteVersion) ||
      readOfficialVersion(application) !== plan.officialVersion ||
      current.officialVersion !== plan.officialVersion ||
      releaseForInstallation(
        { ...current, platform: process.platform, arch: process.arch },
        plan.metadata,
      ).compatibility !== 'enhancement'
    )
      throw Error('待安装更新与官方桌面不兼容')
    await profilesStopped(current)
    const previous = await verifyDirectory(current.release, {
      version: current.suiteVersion,
      officialVersion: current.officialVersion,
    })
    if (previous.artifact.updateProtocolVersion !== 1) throw Error('原安装不支持安全更新协议')
    if (
      previous.artifactSha256 !== plan.originalArtifactSha256 ||
      previous.artifact.suiteSha256 !== current.suiteSha256 ||
      previous.artifact.sha256 !== current.enhancementSha256
    )
      throw Error('原安装文件已改变')
    await directory(join(root, 'updates'))
    const stage = join(root, 'updates', plan.stage)
    await directory(stage)
    const archive = await regularFile(join(stage, 'payload.zip'), 32 * 1024 * 1024)
    if (
      archive.length !== plan.metadata.asset.size ||
      'sha256:' + digest(archive) !== plan.metadata.asset.digest
    )
      throw Error('待安装 ZIP 校验失败')
    const entries = unpackPayload(archive)
    const artifact = verifyEntries(entries, {
      version: plan.version,
      officialVersion: plan.officialVersion,
    })
    if (artifact.updateProtocolVersion !== 1) throw Error('待安装文件不支持安全更新协议')
    if (
      digest(entries.get('artifact.json')) !== plan.artifactSha256 ||
      artifact.suiteSha256 !== plan.suiteSha256
    )
      throw Error('待安装清单校验失败')
    const payload = join(stage, 'payload')
    const staged = await verifyDirectory(payload, {
      version: plan.version,
      officialVersion: plan.officialVersion,
    })
    if (staged.artifactSha256 !== plan.artifactSha256) throw Error('待安装文件已改变')
    const profileReceipt = join(current.profileHome, 'opl-dsh/installation.json')
    const oldProfileReceipt = await readOptional(profileReceipt, 128 * 1024)
    await profilesStopped(current)
    if (
      digest((await installed(root, application)).bytes) !== plan.installationSha256 ||
      readOfficialVersion(application) !== plan.officialVersion
    )
      throw Error('启动安装前原安装已改变')
    try {
      if (transaction) await assertUpdateTransaction(root, transaction)
      runInstaller(payload, application, root, current)
      await confirmInstalled(root, application, artifact, current)
    } catch (error) {
      rollback = 'failed'
      try {
        if (transaction) await assertUpdateTransaction(root, transaction)
        await profilesStopped(current)
        runInstaller(current.release, application, root, current, current.localCandidate === true)
        await confirmInstalled(root, application, previous.artifact, current)
        await writeFile(join(root, 'installation.json'), installationBytes, { mode: 0o600 })
        if (oldProfileReceipt !== null)
          await writeFile(profileReceipt, oldProfileReceipt, { mode: 0o600 })
        rollback = 'succeeded'
      } catch (rollbackError) {
        // Both immutable release directories and the failed plan remain available for repair.
      }
      throw error
    }
    await unlink(join(root, pendingName))
    await atomicJson(join(root, 'enhancement-update.json'), {
      checkedAt: new Date().toISOString(),
      trigger: 'prepared-launcher',
      state: 'updated',
      version: plan.version,
    })
  } catch {
    await atomicJson(join(root, 'enhancement-update.json'), {
      checkedAt: new Date().toISOString(),
      trigger: 'prepared-launcher',
      state: 'deferred',
      ...(rollback ? { rollback } : {}),
      message: '本次增强更新未完成，已保留更新计划和原安装包。',
    }).catch(() => {})
  } finally {
    await unlock?.().catch(() => {})
  }
}
