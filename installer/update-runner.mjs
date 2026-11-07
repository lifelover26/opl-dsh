/** Independently finish one verified enhancement update after a clean Desktop shutdown. */
import { readFile, lstat, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { installationPaths } from './installation-paths.mjs'
import { newer, validateReleaseMetadata } from './update-discovery.mjs'
import { launchIndependent, quoteWindowsArgument } from './windows-lifecycle.mjs'
import {
  acquireUpdateTransaction,
  readUpdateTransaction,
  assertUpdateTransaction,
  handoffUpdateTransaction,
  claimUpdateTransaction,
  transitionUpdateTransaction,
  finishUpdateTransaction,
  updateTransactionDirectory,
  updateProcessAlive,
} from './update-transaction.mjs'

export { acknowledgeUpdateShutdown } from './update-transaction.mjs'

const hashPattern = /^[a-f0-9]{64}$/u
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const stagePattern = /^prepared-[a-f0-9]{64}-[a-zA-Z0-9]+$/u
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

function failure(code) {
  const error = Error(code)
  error.code = code
  return error
}

async function directory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('unsafe-update-directory')
}

async function bytes(path, limit = 128 * 1024, optional = false) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
      throw failure('unsafe-update-file')
    return await readFile(path)
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null
    throw error
  }
}

function payloadPath(path) {
  if (
    typeof path !== 'string' ||
    path.includes('\\') ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[:\x00-\x1f<>"|?*]/u.test(part) ||
          /[. ]$/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    throw failure('invalid-update-payload-path')
}

async function verifyArtifact(path) {
  await directory(path)
  const artifactBytes = await bytes(join(path, 'artifact.json'))
  const artifact = JSON.parse(artifactBytes.toString('utf8'))
  if (
    artifact.updateProtocolVersion !== 1 ||
    artifact.unattendedUpdateProtocolVersion !== 1 ||
    artifact.sourceDirty === true ||
    !artifact.payloadFiles ||
    typeof artifact.payloadFiles !== 'object' ||
    Array.isArray(artifact.payloadFiles) ||
    !hashPattern.test(artifact.suiteSha256) ||
    artifact.suiteSha256 !== digest(JSON.stringify(artifact.payloadFiles)) ||
    !hashPattern.test(artifact.sha256) ||
    !/^opl-dsh-enhancements-[a-zA-Z0-9.-]+\.tgz$/u.test(artifact.name) ||
    artifact.payloadFiles[artifact.name] !== artifact.sha256 ||
    Object.keys(artifact.payloadFiles).length > 4096
  )
    throw failure('unattended-update-unsupported')
  for (const name of ['setup.mjs', 'update.mjs', 'update-runner.mjs', 'update-transaction.mjs'])
    if (!Object.hasOwn(artifact.payloadFiles, name)) throw failure('unattended-update-unsupported')
  const names = new Set()
  const actual = new Set(['artifact.json'])
  let size = 0
  for (const [name, hash] of Object.entries(artifact.payloadFiles)) {
    payloadPath(name)
    if (!hashPattern.test(hash) || name === 'artifact.json' || names.has(name.toLowerCase()))
      throw failure('invalid-update-payload')
    names.add(name.toLowerCase())
    const parts = name.split('/')
    for (let n = 1; n < parts.length; n++) await directory(join(path, ...parts.slice(0, n)))
    const content = await bytes(join(path, name), 256 * 1024 * 1024)
    size += content.length
    if (size > 256 * 1024 * 1024 || digest(content) !== hash)
      throw failure('update-payload-changed')
    actual.add(name)
  }
  const expectedDirectories = new Set(
    [...names].flatMap((name) => {
      const parts = name.split('/')
      return parts.slice(1).map((_part, index) => parts.slice(0, index + 1).join('/'))
    }),
  )
  async function scan(directoryPath, prefix = '') {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      payloadPath(relative)
      if (entry.isSymbolicLink()) throw failure('unsafe-update-file')
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relative)) throw failure('unlisted-update-directory')
        await scan(join(directoryPath, entry.name), relative)
      } else if (entry.isFile()) {
        if (!actual.has(relative)) throw failure('unlisted-update-file')
      } else throw failure('unsafe-update-file')
    }
  }
  await scan(path)
  return { artifact, artifactSha256: digest(artifactBytes) }
}

function releaseIdentity(artifact, artifactSha256) {
  return {
    suiteVersion: artifact.enhancementVersion ?? artifact.version,
    officialVersion: artifact.officialVersion,
    suiteSha256: artifact.suiteSha256,
    enhancementSha256: artifact.sha256,
    artifactSha256,
  }
}

async function installed(root, application, profileHome) {
  await directory(root)
  const receiptBytes = await bytes(join(root, 'installation.json'))
  const current = installationPaths(JSON.parse(receiptBytes.toString('utf8')), {
    suiteRoot: root,
    profileHome,
  })
  if (
    current.localCandidate === true ||
    !isAbsolute(current.app ?? '') ||
    resolve(current.app) !== resolve(application) ||
    !isAbsolute(current.skillDir ?? '') ||
    !hashPattern.test(current.suiteSha256) ||
    !hashPattern.test(current.enhancementSha256) ||
    resolve(current.release) !== resolve(root, 'releases', current.suiteSha256)
  )
    throw failure('installation-identity-mismatch')
  await directory(join(root, 'releases'))
  const { artifact, artifactSha256 } = await verifyArtifact(current.release)
  const identity = releaseIdentity(artifact, artifactSha256)
  for (const key of ['suiteVersion', 'officialVersion', 'suiteSha256', 'enhancementSha256'])
    if (current[key] !== identity[key]) throw failure('installation-receipt-changed')
  return { current, receiptBytes, identity }
}

async function updateInputs(root, application, profileHome, options = {}) {
  const {
    current,
    receiptBytes,
    identity: source,
  } = await installed(root, application, profileHome)
  const pendingBytes = await bytes(join(root, 'enhancement-pending.json'), 1024 * 1024)
  const pending = JSON.parse(pendingBytes.toString('utf8'))
  if (
    pending.schemaVersion !== 1 ||
    !stagePattern.test(pending.stage) ||
    pending.application !== resolve(application) ||
    pending.installationSha256 !== digest(receiptBytes) ||
    pending.originalArtifactSha256 !== source.artifactSha256 ||
    !hashPattern.test(pending.artifactSha256) ||
    !hashPattern.test(pending.suiteSha256) ||
    !Number.isFinite(Date.parse(pending.preparedAt)) ||
    pending.officialVersion !== current.officialVersion ||
    !newer(pending.version, current.suiteVersion)
  )
    throw failure('prepared-update-changed')
  const metadata = validateReleaseMetadata(pending.metadata)
  if (
    metadata.manifest.enhancement.updateProtocolVersion !== 1 ||
    metadata.manifest.enhancement.unattendedUpdateProtocolVersion !== 1 ||
    metadata.manifest.enhancement.version !== pending.version ||
    metadata.manifest.official.version !== pending.officialVersion
  )
    throw failure('unattended-update-unsupported')
  await directory(join(root, 'updates'))
  const stage = join(root, 'updates', pending.stage)
  await directory(stage)
  const archive = await bytes(join(stage, 'payload.zip'), 32 * 1024 * 1024)
  if (
    metadata.asset.size !== archive.length ||
    metadata.asset.digest !== 'sha256:' + digest(archive)
  )
    throw failure('prepared-archive-changed')
  const { artifact, artifactSha256 } = await verifyArtifact(join(stage, 'payload'))
  const target = releaseIdentity(artifact, artifactSha256)
  if (
    target.suiteVersion !== pending.version ||
    target.officialVersion !== pending.officialVersion ||
    target.suiteSha256 !== pending.suiteSha256 ||
    target.artifactSha256 !== pending.artifactSha256
  )
    throw failure('prepared-update-changed')
  const readVersion =
    options.readOfficialVersion ?? (await import('./update.mjs')).readOfficialVersion
  if ((await readVersion(application)) !== current.officialVersion)
    throw failure('official-version-changed')
  return {
    current,
    source: { ...source, skillDir: current.skillDir },
    target,
    sourceReceiptSha256: digest(receiptBytes),
    targetPendingSha256: digest(pendingBytes),
  }
}

async function profiles(root, profileHome, isAlive) {
  const result = []
  // SuperAgent has its own home but shares the Suite's release generation.
  for (const home of [profileHome, join(root, 'superagent', 'home')]) {
    const path = join(home, 'profiles')
    let names
    try {
      await directory(path)
      names = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const name of names) {
      if (name.isSymbolicLink()) throw failure('profile-state-unconfirmed')
      if (!name.isDirectory()) continue
      const raw = await bytes(join(path, name.name, 'control.json'), 128 * 1024, true)
      if (raw === null) continue
      const control = JSON.parse(raw.toString('utf8'))
      if (!Number.isSafeInteger(control.pid) || control.pid <= 0)
        throw failure('profile-state-unconfirmed')
      if (isAlive(control.pid))
        result.push({ home: resolve(home), name: name.name, pid: control.pid })
    }
  }
  return result
}

async function ownedDesktop(root, application, profileHome, desktop, isAlive) {
  if (!desktop || !uuid.test(desktop.nonce)) throw failure('desktop-ownership-unconfirmed')
  const raw = await bytes(join(root, 'desktop-launch.json'))
  const launch = JSON.parse(raw.toString('utf8'))
  if (
    launch.schemaVersion !== 1 ||
    launch.nonce !== desktop.nonce ||
    launch.application !== resolve(application) ||
    launch.profileHome !== resolve(profileHome) ||
    !hashPattern.test(launch.suiteSha256)
  )
    throw failure('desktop-ownership-unconfirmed')
  for (const key of ['launcherPid', 'desktopPid'])
    if (
      !Number.isSafeInteger(desktop[key]) ||
      desktop[key] <= 0 ||
      launch[key] !== desktop[key] ||
      !isAlive(desktop[key])
    )
      throw failure('desktop-ownership-unconfirmed')
  const live = await profiles(root, profileHome, isAlive)
  if (
    live.length !== 1 ||
    live[0].home !== resolve(profileHome) ||
    live[0].name !== 'desktop' ||
    live[0].pid !== desktop.hostPid
  )
    throw failure(
      live.some((item) => item.pid !== desktop.hostPid)
        ? 'other-profile-running'
        : 'desktop-host-unconfirmed',
    )
  return { ...desktop, launchSha256: digest(raw), suiteSha256: launch.suiteSha256 }
}

/** Verify the exact receipt, staged plan and current owned Desktop before reserving the Suite. */
export async function prepareUnattendedTransaction(
  { root, application, profileHome, desktop },
  options = {},
) {
  const isAlive = options.isAlive ?? updateProcessAlive
  const inputs = await updateInputs(root, application, profileHome, options)
  const ownership = await ownedDesktop(root, application, profileHome, desktop, isAlive)
  if (ownership.suiteSha256 !== inputs.source.suiteSha256) throw failure('desktop-release-mismatch')
  const lease = await acquireUpdateTransaction(root, {
    application,
    profileHome,
    source: inputs.source,
    target: inputs.target,
    sourceReceiptSha256: inputs.sourceReceiptSha256,
    targetPendingSha256: inputs.targetPendingSha256,
    desktop: ownership,
  })
  try {
    await unchangedInputs(root, await readUpdateTransaction(root, lease), options)
    return lease
  } catch (error) {
    await finishUpdateTransaction(root, lease, { stage: 'failed', failure: safeCode(error) })
    throw error
  }
}

async function unchangedInputs(root, record, options) {
  const inputs = await updateInputs(root, record.application, record.profileHome, options)
  if (
    inputs.sourceReceiptSha256 !== record.sourceReceiptSha256 ||
    inputs.targetPendingSha256 !== record.targetPendingSha256 ||
    JSON.stringify(inputs.source) !== JSON.stringify(record.source) ||
    JSON.stringify(inputs.target) !== JSON.stringify(record.target)
  )
    throw failure('update-inputs-changed')
  return inputs
}

function executable(application) {
  return join(
    application,
    process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'Contents/MacOS/DeepSeek Harness',
  )
}

/** Build the WSH environment wrapper required by WMI's environment-free process creation. */
export function windowsUpdateWrapper({ command, args, root, codexHome }) {
  const literal = (value) => '"' + String(value).replaceAll('"', '""') + '"'
  const line = [command, ...args].map(quoteWindowsArgument).join(' ')
  return [
    'Set shell = CreateObject("WScript.Shell")',
    'shell.CurrentDirectory = ' + literal(root),
    'shell.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"',
    'shell.Environment("Process")("NODE_USE_SYSTEM_CA") = "1"',
    'shell.Environment("Process")("CODEX_HOME") = ' + literal(codexHome),
    'shell.Run ' + literal(line) + ', 0, False',
    '',
  ].join('\r\n')
}

async function startNode(root, record, name, script, args, current) {
  const command = executable(record.application)
  const codexHome = dirname(dirname(current.skillDir))
  if (process.platform !== 'win32')
    return launchIndependent({
      command,
      args: [script, ...args],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_USE_SYSTEM_CA: '1',
        CODEX_HOME: codexHome,
      },
      label: name,
    })
  const wrapper = join(updateTransactionDirectory(root, record.id), `${name}.vbs`)
  await writeFile(
    wrapper,
    Buffer.from(
      '\ufeff' + windowsUpdateWrapper({ command, args: [script, ...args], root, codexHome }),
      'utf16le',
    ),
    { flag: 'wx', mode: 0o600 },
  )
  return launchIndependent({ command: 'wscript.exe', args: [wrapper], label: name })
}

function acceptedLaunch(started) {
  if (
    !started ||
    started.refusal ||
    !Number.isSafeInteger(started.pid) ||
    started.pid <= 0 ||
    (process.platform === 'win32' && started.guarantee !== 'job-independent')
  )
    throw failure('independent-start-refused')
}

/** Start the source receipt's verified runner, and wait for its one-time ownership claim. */
export async function launchUpdateRunner(root, lease, options = {}) {
  const record = await assertUpdateTransaction(root, lease, ['acquired'])
  const { current } = await unchangedInputs(root, record, options)
  await handoffUpdateTransaction(root, lease, { timeoutMs: options.handoffTimeoutMs ?? 30_000 })
  try {
    const start =
      options.start ??
      ((value) =>
        startNode(
          root,
          record,
          'update-runner',
          join(current.release, 'update-runner.mjs'),
          [root, lease.id, lease.nonce],
          value,
        ))
    const started = await start(current)
    acceptedLaunch(started)
    const now = options.now ?? (() => performance.now())
    const wait = options.wait ?? pause
    const deadline = now() + (options.handoffTimeoutMs ?? 30_000)
    while (now() <= deadline) {
      const state = await readUpdateTransaction(root, lease)
      if (state.stage === 'waiting-exit') return started
      if (state.stage !== 'handoff') throw failure('runner-handoff-failed')
      await wait(100)
    }
    throw failure('runner-handoff-timeout')
  } catch (error) {
    // If the runner claimed ownership, its durable outcome belongs to it.
    const state = await readUpdateTransaction(root, lease)
    if (state.ownerPid === lease.ownerPid && ['acquired', 'handoff'].includes(state.stage))
      await finishUpdateTransaction(root, lease, { stage: 'failed', failure: safeCode(error) })
    throw error
  }
}

async function stoppedAndDrained(root, record, options) {
  const now = options.now ?? (() => performance.now())
  const wait = options.wait ?? pause
  const isAlive = options.isAlive ?? updateProcessAlive
  const deadline = now() + (options.exitTimeoutMs ?? 60_000)
  while (now() <= deadline) {
    const state = await readUpdateTransaction(root, record)
    if (state.stage !== 'waiting-exit') throw failure('update-cancelled')
    const launchBytes = await bytes(join(root, 'desktop-launch.json'), 128 * 1024, true)
    if (launchBytes && digest(launchBytes) !== record.desktop.launchSha256)
      throw failure('desktop-ownership-changed')
    const live = await profiles(root, record.profileHome, isAlive)
    if (
      live.some(
        (item) =>
          item.pid !== record.desktop.hostPid ||
          item.home !== record.profileHome ||
          item.name !== 'desktop',
      )
    )
      throw failure('other-profile-running')
    const stopped = ['hostPid', 'desktopPid', 'launcherPid'].every(
      (key) => !isAlive(record.desktop[key]),
    )
    if (stopped) {
      const markerBytes = await bytes(
        join(updateTransactionDirectory(root, record.id), 'host-drained.json'),
        4096,
        true,
      )
      const marker = markerBytes && JSON.parse(markerBytes.toString('utf8'))
      if (
        !state.shutdown ||
        state.shutdown.clean !== true ||
        !marker ||
        marker.schemaVersion !== 1 ||
        marker.transactionId !== record.id ||
        marker.nonce !== record.nonce ||
        marker.hostPid !== record.desktop.hostPid ||
        marker.clean !== true
      )
        throw failure('clean-shutdown-unconfirmed')
      for (const key of ['hostPid', 'desktopPid', 'launcherPid'])
        if (state.shutdown[key] !== record.desktop[key]) throw failure('shutdown-process-mismatch')
      return
    }
    await wait(100)
  }
  throw failure('desktop-exit-timeout')
}

async function confirmTarget(root, record) {
  const { current, identity } = await installed(root, record.application, record.profileHome)
  if (JSON.stringify(identity) !== JSON.stringify(record.target))
    throw failure('installed-target-unconfirmed')
  if (current.skillDir !== record.source.skillDir) throw failure('installed-paths-changed')
  if (await bytes(join(root, 'enhancement-pending.json'), 1024 * 1024, true))
    throw failure('pending-update-unconsumed')
  return current
}

async function desktopHealthy(root, record) {
  const raw = await bytes(join(root, 'desktop-launch.json'), 128 * 1024, true)
  if (raw === null) return false
  const launch = JSON.parse(raw.toString('utf8'))
  const state = await readUpdateTransaction(root, record)
  if (
    launch.schemaVersion !== 1 ||
    launch.transactionId !== record.id ||
    !uuid.test(launch.nonce) ||
    launch.nonce === record.desktop.nonce ||
    launch.application !== record.application ||
    launch.profileHome !== record.profileHome ||
    launch.suiteSha256 !== record.target.suiteSha256 ||
    launch.launcherPid !== state.launchClaim?.pid ||
    launch.launcherPid === record.desktop.launcherPid ||
    launch.desktopPid === record.desktop.desktopPid ||
    !updateProcessAlive(launch.launcherPid) ||
    !updateProcessAlive(launch.desktopPid)
  )
    return false
  const controlBytes = await bytes(
    join(record.profileHome, 'profiles/desktop/control.json'),
    128 * 1024,
    true,
  )
  if (controlBytes === null) return false
  const control = JSON.parse(controlBytes.toString('utf8'))
  if (
    control.version !== 1 ||
    control.pid === record.desktop.hostPid ||
    !Number.isSafeInteger(control.pid) ||
    control.pid <= 0 ||
    !updateProcessAlive(control.pid) ||
    !hashPattern.test(control.token)
  )
    return false
  const endpoint = new URL(control.endpoint)
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !endpoint.port ||
    endpoint.pathname !== '/rpc' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw failure('health-endpoint-invalid')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + control.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      namespace: 'oplSuite',
      method: 'setupStatus',
      args: {},
      timeoutMs: 2000,
    }),
    signal: AbortSignal.timeout(2500),
  })
  const result = await response.json()
  return response.ok && result.ok === true && typeof result.value?.completed === 'boolean'
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[a-z][a-z0-9-]{0,95}$/u.test(error.code)
    ? error.code
    : 'update-operation-failed'
}

/**
 * Claim and execute one handoff. No code here quits, kills, retries, or rolls
 * back an application. A health timeout preserves the installed target and the
 * single launch attempt for diagnosis.
 */
export async function runUpdateTransaction(root, offeredLease, options = {}) {
  let lease
  try {
    lease = await claimUpdateTransaction(root, offeredLease)
  } catch (error) {
    // An unclaimed or duplicate runner cannot alter another owner's transaction.
    return { state: 'refused', failure: safeCode(error) }
  }
  try {
    const record = await readUpdateTransaction(root, lease)
    await unchangedInputs(root, record, options)
    await stoppedAndDrained(root, record, options)
    await unchangedInputs(root, record, options)
    await transitionUpdateTransaction(root, lease, 'installing')
    const refresh =
      options.refresh ??
      (async (...args) => (await import('./update.mjs')).refreshEnhancements(...args))
    await refresh(root, record.application, { transaction: lease })
    const current = await confirmTarget(root, record)
    await transitionUpdateTransaction(root, lease, 'installed')
    await transitionUpdateTransaction(root, lease, 'starting')
    const start =
      options.start ??
      (() =>
        startNode(
          root,
          record,
          'update-desktop',
          join(current.release, 'setup.mjs'),
          [
            record.profileHome,
            root,
            record.application,
            '--no-update',
            '--update-transaction=' + lease.id,
            '--update-nonce=' + lease.nonce,
          ],
          current,
        ))
    const started = await start({ root, lease, current })
    acceptedLaunch(started)
    await transitionUpdateTransaction(root, lease, 'confirming', {
      launch: { pid: started.pid, method: started.method, attemptedAt: new Date().toISOString() },
    })
    const health = options.health ?? (() => desktopHealthy(root, record))
    const now = options.now ?? (() => performance.now())
    const wait = options.wait ?? pause
    const deadline = now() + (options.healthTimeoutMs ?? 90_000)
    while (now() <= deadline) {
      let healthy = false
      try {
        healthy = await health({ root, lease, current })
      } catch (_error) {
        // A process may not have published its authenticated endpoint yet.
      }
      if (healthy === true) {
        await confirmTarget(root, record)
        await finishUpdateTransaction(root, lease, { stage: 'succeeded' })
        return { state: 'succeeded', version: record.target.suiteVersion }
      }
      await wait(250)
    }
    throw failure('desktop-health-timeout')
  } catch (error) {
    const issue = safeCode(error)
    const state = await readUpdateTransaction(root, lease)
    if (!['failed', 'cancelled', 'succeeded'].includes(state.stage))
      await finishUpdateTransaction(root, lease, { stage: 'failed', failure: issue })
    return { state: state.stage === 'cancelled' ? 'cancelled' : 'failed', failure: issue }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, id, nonce] = process.argv.slice(2)
  try {
    const result = await runUpdateTransaction(root, { id, nonce, ownerPid: process.pid })
    if (result.state !== 'succeeded') process.exitCode = 1
  } catch (_error) {
    // Transaction files hold the bounded outcome; private control data is never printed.
    process.exitCode = 1
  }
}
