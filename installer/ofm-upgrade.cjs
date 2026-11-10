/**
 * Install or recover Our Free Model through official profile dependency operations.
 * Linked installations keep a complete independent package inside the profile;
 * the upstream updater owns its contents. pnpm registers the link and restores
 * the previous dependency if migration fails.
 */
const {
  cp,
  realpath,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} = require('node:fs/promises')
const { createHash, randomUUID } = require('node:crypto')
const { isAbsolute, join, resolve, sep } = require('node:path')

const PACKAGE_NAME = 'dsh-our-free-model'
const LOCK_NAME = '.ofm-upgrade.lock'
const STATE_NAME = '.ofm-upgrade.json'
const RECOVERY_DIR = '.ofm-upgrade-recovery'
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
const LOCK_PID_PATTERN = /^\d+$/u

function transactionError(code, message = code) {
  const error = Error(message)
  error.code = code
  return error
}

function profileRoot(dir) {
  if (typeof dir !== 'string' || !dir || !isAbsolute(dir))
    throw transactionError('invalid-ofm-profile', 'OFM profile path must be absolute')
  return resolve(dir)
}

function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value ?? '').trim())
  if (!match) return undefined
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw transactionError('invalid-ofm-version', `无效的 OFM 版本：${left} / ${right}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumber = /^\d+$/u.test(x)
    const yNumber = /^\d+$/u.test(y)
    if (xNumber && yNumber) return Number(x) > Number(y) ? 1 : -1
    if (xNumber !== yNumber) return xNumber ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

async function regularFile(path, optional = false) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw transactionError('unsafe-ofm-file', `OFM 文件类型无效：${path}`)
    return readFile(path)
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function regularDirectory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw transactionError('unsafe-ofm-directory', `OFM 目录类型无效：${path}`)
}

async function readJson(path, optional = false) {
  const bytes = await regularFile(path, optional)
  if (bytes === undefined) return undefined
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw transactionError('invalid-ofm-json', `OFM JSON 无效：${path}`)
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

async function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    return true
  }
}

async function lockRecord(path) {
  const bytes = await regularFile(path)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw transactionError('invalid-ofm-lock', 'OFM 升级锁记录无效')
  }
  if (!LOCK_PID_PATTERN.test(String(value?.pid ?? '')))
    throw transactionError('invalid-ofm-lock', 'OFM 升级锁进程无效')
  return value
}

async function clearStaleLock(path) {
  const recoveryPath = `${path}.recovery`
  let recovery
  try {
    recovery = await open(recoveryPath, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST')
      throw transactionError('ofm-upgrade-in-progress', '另一项 OFM 升级正在清理锁')
    throw error
  }
  try {
    const current = await lockRecord(path)
    if (await isAlive(Number(current.pid)))
      throw transactionError('ofm-upgrade-in-progress', '另一项 OFM 升级正在进行')
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  } finally {
    await recovery.close()
    await unlink(recoveryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** Acquire the profile-local OFM transaction lock, recovering dead owners. */
async function acquireLock(dir) {
  const path = join(dir, LOCK_NAME)
  await regularDirectory(dir)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          transactionId: randomUUID(),
          startedAt: new Date().toISOString(),
        }),
      )
      let released = false
      return async () => {
        if (released) return
        released = true
        await handle.close()
        await unlink(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = await lockRecord(path)
      if (await isAlive(Number(owner.pid)))
        throw transactionError('ofm-upgrade-in-progress', '另一项 OFM 升级正在进行')
      await clearStaleLock(path)
    }
  }
  throw transactionError('ofm-upgrade-lock-failed', '无法取得 OFM 升级锁')
}

/** Return whether the installed OFM still has pnpm's hard-link ownership. */
async function isPackageManagerOwned(packageDir) {
  for (const name of ['package.json', 'index.js', 'client.js']) {
    try {
      const stat = await lstat(join(packageDir, name))
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink > 1) return true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return false
}

async function inspectOfm(dir) {
  const manifestPath = join(dir, 'package.json')
  const manifest = await readJson(manifestPath)
  if (
    manifest === undefined ||
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest)
  )
    throw transactionError('invalid-ofm-profile', 'OFM profile package.json 无效')
  const dependency = manifest.dependencies?.[PACKAGE_NAME]
  const packageDir = join(dir, 'node_modules', PACKAGE_NAME)
  const packageManifest = await readJson(join(packageDir, 'package.json'), true)
  const installedVersion =
    packageManifest && typeof packageManifest.version === 'string'
      ? packageManifest.version
      : undefined
  return {
    dependency: typeof dependency === 'string' ? dependency : undefined,
    installed: packageManifest !== undefined,
    installedVersion,
    managed: packageManifest === undefined ? false : await isPackageManagerOwned(packageDir),
    packageDir,
  }
}

async function snapshotFile(source, destination) {
  const bytes = await regularFile(source, true)
  if (bytes === undefined) return false
  await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
  await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' })
  return true
}

async function snapshotProfile(dir, transactionId, packageDir) {
  const root = join(dir, RECOVERY_DIR, transactionId)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const files = []
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-lock.yml', 'pnpm-workspace.yaml']) {
    if (await snapshotFile(join(dir, name), join(root, name))) files.push(name)
  }
  const modules = join(dir, 'node_modules', '.modules.yaml')
  if (await snapshotFile(modules, join(root, 'node_modules/.modules.yaml')))
    files.push('node_modules/.modules.yaml')
  const metadata = `node_modules/${PACKAGE_NAME}/package.json`
  if (await snapshotFile(join(packageDir, 'package.json'), join(root, metadata)))
    files.push(metadata)
  return { root, files }
}

async function restoreSnapshot(dir, snapshot, install, before) {
  // pnpm restores package files and hard links; saved metadata is recovery evidence.
  let managerRestored = false
  try {
    if (before.resetInstalled && (await inspectOfm(dir)).dependency !== before.dependency)
      await install(['remove', PACKAGE_NAME])
    const args =
      before.dependency === undefined
        ? ['remove', PACKAGE_NAME]
        : ['add', `${PACKAGE_NAME}@${before.dependency}`]
    await install(args)
    const after = await inspectOfm(dir)
    managerRestored =
      after.dependency === before.dependency &&
      after.installedVersion === before.installedVersion &&
      (!before.managed || after.managed)
  } catch {
    // The snapshot remains available for a later recovery call.
  }
  return managerRestored
}

function recoveryPath(dir, value) {
  if (typeof value !== 'string' || !isAbsolute(value))
    throw transactionError('invalid-ofm-recovery', 'OFM 恢复目录无效')
  const root = resolve(dir)
  const expected = resolve(root, RECOVERY_DIR)
  const candidate = resolve(value)
  if (candidate !== expected && !candidate.startsWith(expected + sep))
    throw transactionError('invalid-ofm-recovery', 'OFM 恢复目录超出 profile')
  return candidate
}

function failureDetails(error) {
  const code =
    typeof error?.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(error.code)
      ? error.code
      : 'ofm-upgrade-failed'
  const message = String(error?.message ?? error)
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 512)
  return { code, message }
}

async function saveState(dir, value) {
  await atomicJson(join(dir, STATE_NAME), value)
}

/** Read the last durable OFM transaction state, if one exists. */
async function readOfmState(dir) {
  return readJson(join(profileRoot(dir), STATE_NAME), true)
}

async function archiveState(dir, state) {
  const path = join(dir, STATE_NAME)
  await saveState(dir, state)
  return path
}

/**
 * Upgrade OFM using the supplied official package-manager operation.
 *
 * @param {object} options
 * @param {string} options.dir - absolute desktop profile directory
 * @param {(args: string[]) => Promise<unknown>} options.install - official pnpm operation
 * @param {object} options.plugin - verified release descriptor from model-plugins.cjs
 * @param {(url: string, init?: object) => Promise<Response>} [options.fetchImpl]
 * @returns {Promise<object>} durable transaction result
 */
async function upgradeOfm({
  dir,
  install,
  plugin,
  fetchImpl,
  now = () => new Date().toISOString(),
}) {
  const root = profileRoot(dir)
  if (typeof install !== 'function')
    throw transactionError('invalid-ofm-installer', '缺少官方 pnpm 操作')
  if (!plugin || plugin.name !== PACKAGE_NAME || typeof plugin.version !== 'string')
    throw transactionError('invalid-ofm-release', 'OFM 发布描述无效')
  if (!parseVersion(plugin.version) || typeof plugin.sha256 !== 'string')
    throw transactionError('invalid-ofm-release', 'OFM 发布版本或摘要无效')
  const unlock = await acquireLock(root)
  const transactionId = randomUUID()
  let snapshot
  let release
  let before
  try {
    before = await inspectOfm(root)
    const base = {
      schemaVersion: 1,
      transactionId,
      packageName: PACKAGE_NAME,
      targetVersion: plugin.version,
      archive: undefined,
      versionBefore: before.installedVersion ?? null,
      dependencyBefore: before.dependency ?? null,
      managedBefore: before.managed,
      startedAt: now(),
      updatedAt: now(),
    }
    if (
      before.installedVersion !== undefined &&
      compareVersions(before.installedVersion, plugin.version) >= 0
    ) {
      const result = {
        ...base,
        phase: 'skipped',
        reason: 'installed-version-is-newer-or-equal',
        managed: before.managed,
      }
      await archiveState(root, { ...result, finishedAt: now() })
      return result
    }
    release = await require('./model-plugins.cjs').prepareModelPlugin({
      dir: root,
      plugin,
      ...(fetchImpl ? { fetchImpl } : {}),
    })
    base.archive = release
    snapshot = await snapshotProfile(root, transactionId, before.packageDir)
    await saveState(root, {
      ...base,
      phase: 'installing',
      recoveryPath: snapshot.root,
      updatedAt: now(),
    })
    await install(['add', release])
    const after = await inspectOfm(root)
    if (
      after.installedVersion === undefined ||
      compareVersions(after.installedVersion, plugin.version) < 0
    )
      throw transactionError('ofm-version-not-updated', '官方 pnpm 未安装目标 OFM 版本')
    const result = {
      ...base,
      phase: 'succeeded',
      versionAfter: after.installedVersion,
      managed: after.managed,
      finishedAt: now(),
    }
    await archiveState(root, result)
    await rm(snapshot.root, { recursive: true, force: true })
    return result
  } catch (error) {
    if (snapshot === undefined) throw error
    const failure = failureDetails(error)
    const recovered = await restoreSnapshot(root, snapshot, install, before)
    const state = {
      schemaVersion: 1,
      transactionId,
      packageName: PACKAGE_NAME,
      targetVersion: plugin.version,
      archive: release,
      versionBefore: before?.installedVersion ?? null,
      dependencyBefore: before?.dependency ?? null,
      managedBefore: before?.managed === true,
      phase: recovered ? 'recovered' : 'recovery-required',
      recoveryPath: snapshot?.root,
      failure,
      finishedAt: now(),
    }
    await archiveState(root, state).catch(() => {})
    if (error && typeof error === 'object') {
      error.recovery = recovered ? 'restored-by-pnpm' : 'backup-retained'
      error.transactionId = transactionId
    }
    throw error
  } finally {
    await unlock()
  }
}

/** Recover the most recent failed transaction using pnpm and its retained snapshot. */
async function recoverOfmUpgrade({ dir, install, restoreBundles }) {
  const root = profileRoot(dir)
  if (typeof install !== 'function')
    throw transactionError('invalid-ofm-installer', '缺少官方 pnpm 操作')
  const state = await readOfmState(root)
  if (
    !state ||
    !['recovery-required', 'installing'].includes(state.phase) ||
    typeof state.recoveryPath !== 'string'
  )
    return state
  const unlock = await acquireLock(root)
  try {
    const snapshot = { root: recoveryPath(root, state.recoveryPath) }
    const restored = await restoreSnapshot(root, snapshot, install, {
      dependency: state.dependencyBefore === null ? undefined : state.dependencyBefore,
      installedVersion: state.versionBefore === null ? undefined : state.versionBefore,
      managed: state.managedBefore === true,
      resetInstalled: state.resetInstalled === true,
    })
    if (state.bundlesBefore !== undefined) {
      if (!restoreBundles) throw transactionError('missing-ofm-bundle-restorer')
      await restoreBundles(state.bundlesBefore)
    }
    const next = {
      ...state,
      phase: restored ? 'recovered' : 'recovery-required',
      recoveredAt: new Date().toISOString(),
    }
    await saveState(root, next)
    if (restored) await rm(snapshot.root, { recursive: true, force: true })
    return next
  } finally {
    await unlock()
  }
}

/** Install a complete OFM package whose contents are owned by its upstream updater.
 * Existing OFM data stays in DSH_HOME/our-free-model; bundle ids and settings are unchanged.
 * @param {object} options - Profile and official pnpm operation.
 * @returns {Promise<object>} Installation outcome.
 */
async function migrateOfmLink({ dir, install, plugin, fetchImpl, restoreBundles }) {
  const root = profileRoot(dir)
  const unlock = await acquireLock(root)
  const target = join(root, 'ofm', PACKAGE_NAME)
  const dependency = `link:ofm/${PACKAGE_NAME}`
  const stage = join(root, `.ofm-stage-${randomUUID()}`)
  let created = false
  let snapshot
  let before
  let bundlesBefore
  try {
    await require('./ofm-owner.cjs').stopped(root)
    before = await inspectOfm(root)
    bundlesBefore = (await readJson(join(root, 'package.json'))).dsh?.profile?.bundles
    if (before.dependency === dependency) {
      await regularDirectory(target)
      if (!before.installed) {
        await install(['install'])
        before = await inspectOfm(root)
      }
      if ((await realpath(before.packageDir)) !== (await realpath(target)))
        throw transactionError('invalid-ofm-link', 'OFM 链接目标不匹配')
      if (before.managed) throw transactionError('invalid-ofm-link', 'OFM 目标仍有包管理器硬链接')
      return { phase: 'skipped', reason: 'self-managed-link', version: before.installedVersion }
    }
    // Only migrate the suite's exact retained vendor archive dependency.
    if (before.dependency !== undefined) {
      const normalized = before.dependency.replaceAll(String.fromCharCode(92), '/')
      const vendor = join(root, 'vendor').replaceAll(String.fromCharCode(92), '/')
      const tail = normalized.startsWith(`file:${vendor}/`)
        ? normalized.slice(`file:${vendor}/`.length)
        : normalized.startsWith('file:vendor/')
          ? normalized.slice('file:vendor/'.length)
          : ''
      const own = /^dsh-our-free-model-[0-9]+[.][0-9]+[.][0-9]+[.]tgz$/u.test(tail)
      const manifest = await readJson(join(root, 'package.json'))
      if (
        !own ||
        !normalized.endsWith('.tgz') ||
        !manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME)
      ) {
        if (!before.installed) await install(['install'])
        return { phase: 'skipped', reason: 'user-owned-dependency' }
      }
      await regularFile(join(root, 'vendor', tail))
    }
    if (before.dependency !== undefined && typeof restoreBundles !== 'function')
      throw transactionError('missing-ofm-bundle-restorer', 'OFM 迁移需要官方 bundle 顺序恢复操作')
    try {
      await lstat(target)
      throw transactionError('ofm-target-exists', 'OFM 自管理目录已存在，未覆盖')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (before.installed) {
      await cp(await realpath(before.packageDir), stage, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      })
    } else {
      const archive = await require('./model-plugins.cjs').prepareModelPlugin({
        dir: root,
        plugin,
        fetchImpl,
      })
      await mkdir(stage)
      await new Promise((resolve, reject) => {
        require('node:child_process').execFile(
          process.platform === 'win32'
            ? join(process.env.SystemRoot, 'System32', 'tar.exe')
            : 'tar',
          ['-xzf', archive, '-C', stage, '--strip-components=1'],
          (error) => (error ? reject(error) : resolve()),
        )
      })
    }
    const metadata = await readJson(join(stage, 'package.json'))
    if (metadata.name !== PACKAGE_NAME || !parseVersion(metadata.version))
      throw transactionError('invalid-ofm-release', 'OFM 完整包标识无效')
    for (const file of ['index.js', 'client.js', 'cordis.patch.yml'])
      await regularFile(join(stage, file))
    if (await isPackageManagerOwned(stage))
      throw transactionError('invalid-ofm-copy', 'OFM 副本仍有硬链接')
    await mkdir(join(root, 'ofm'), { recursive: true })
    await regularDirectory(join(root, 'ofm'))
    await require('./ofm-owner.cjs').stopped(root)
    await rename(stage, target)
    created = true
    snapshot = await snapshotProfile(root, randomUUID(), before.packageDir)
    await saveState(root, {
      schemaVersion: 1,
      phase: 'installing',
      bundlesBefore,
      resetInstalled: true,
      dependencyBefore: before.dependency ?? null,
      versionBefore: before.installedVersion ?? null,
      managedBefore: before.managed,
      recoveryPath: snapshot.root,
    })
    if (before.dependency !== undefined) await install(['remove', PACKAGE_NAME])
    await install(['add', `${PACKAGE_NAME}@${dependency}`])
    if (bundlesBefore !== undefined && restoreBundles) await restoreBundles(bundlesBefore)
    const after = await inspectOfm(root)
    if (
      after.dependency !== dependency ||
      after.installedVersion !== metadata.version ||
      (await realpath(after.packageDir)) !== (await realpath(target)) ||
      after.managed
    )
      throw transactionError('invalid-ofm-link', '官方 pnpm 未登记预期的 OFM 链接')
    await saveState(root, {
      schemaVersion: 1,
      phase: 'succeeded',
      versionAfter: metadata.version,
      dependency,
    })
    await rm(snapshot.root, { recursive: true, force: true })
    return { phase: 'succeeded', version: metadata.version, dependency }
  } catch (error) {
    if (created) {
      let restored = await restoreSnapshot(root, snapshot ?? {}, install, {
        ...before,
        resetInstalled: true,
      })
      if (bundlesBefore !== undefined && restoreBundles) {
        try {
          await restoreBundles(bundlesBefore)
        } catch {
          restored = false
        }
      }
      await saveState(root, {
        schemaVersion: 1,
        phase: restored ? 'recovered' : 'recovery-required',
        dependencyBefore: before.dependency ?? null,
        versionBefore: before.installedVersion ?? null,
        managedBefore: before.managed,
        recoveryPath: snapshot?.root,
        bundlesBefore,
        resetInstalled: true,
      })
      error.recovery = restored ? 'restored-by-pnpm' : 'backup-retained'
      if (restored) await rm(target, { recursive: true, force: true })
    }
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
    await unlock()
  }
}

module.exports = {
  migrateOfmLink,
  PACKAGE_NAME,
  compareVersions,
  inspectOfm,
  isPackageManagerOwned,
  readOfmState,
  recoverOfmUpgrade,
  upgradeOfm,
}
