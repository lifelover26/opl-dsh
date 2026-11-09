/** Serialize Suite launches and one durable, independently owned enhancement update. */
import { open, readFile, lstat, mkdir, rename, unlink, rm, link } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const hash = /^[a-f0-9]{64}$/u
const terminal = new Set(['succeeded', 'failed', 'cancelled'])
const successors = {
  acquired: ['handoff'],
  handoff: ['waiting-exit'],
  'waiting-exit': ['installing'],
  installing: ['installed'],
  installed: ['starting'],
  starting: ['confirming'],
  confirming: ['succeeded'],
}
const suiteLockName = 'enhancement-transaction.lock'
const pointerName = 'enhancement-transaction.json'

function failure(code) {
  const error = Error(code)
  error.code = code
  return error
}

function pid(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw failure('invalid-process-identity')
  return value
}

/** A reused or inaccessible PID remains live; this helper never signals a process. */
export function updateProcessAlive(value) {
  pid(value)
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

async function directory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('unsafe-update-directory')
}

async function json(path, optional = false) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
      throw failure('unsafe-transaction-file')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null
    throw error
  }
}

async function write(path, value, exclusive = false) {
  // Readers must only see complete records. A hard link publishes the fully
  // written same-directory temporary file atomically without replacing an owner.
  const temporary = `${path}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n')
    await handle.sync()
    await handle.close()
    handle = undefined
    if (exclusive) await link(temporary, path)
    else await rename(temporary, path)
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
}

async function removeOwned(path, expected) {
  const current = await json(path, true)
  if (current === null) return
  if (current.id !== expected.id || current.nonce !== expected.nonce)
    throw failure('transaction-ownership-changed')
  await unlink(path)
}

// This short gate protects lock acquisition, handoff and state replacement. A
// malformed or interrupted recovery record fails closed instead of removing an
// unidentifiable owner's lock.
async function withGate(root, action) {
  await directory(root)
  const path = join(root, 'enhancement-suite-gate.lock')
  const owner = { id: randomUUID(), nonce: randomUUID(), pid: process.pid }
  const deadline = Date.now() + 5000
  while (true) {
    try {
      await write(path, owner, true)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const previous = await json(path, true)
      if (previous === null) continue
      if (!uuid.test(previous.nonce) || !uuid.test(previous.id)) throw failure('invalid-suite-gate')
      if (!updateProcessAlive(previous.pid)) {
        const recoveryPath = `${path}.recovery`
        await write(recoveryPath, owner, true)
        try {
          const current = await json(path, true)
          if (
            current &&
            current.id === previous.id &&
            current.nonce === previous.nonce &&
            !updateProcessAlive(current.pid)
          )
            await unlink(path)
        } finally {
          await removeOwned(recoveryPath, owner)
        }
        continue
      }
      if (Date.now() >= deadline) throw failure('suite-operation-busy')
      await new Promise((done) => setTimeout(done, 20))
    }
  }
  try {
    return await action()
  } finally {
    await removeOwned(path, owner)
  }
}

/** Return the owned directory of one transaction, without accepting arbitrary paths. */
export function updateTransactionDirectory(root, id) {
  if (!uuid.test(id)) throw failure('invalid-transaction-id')
  return join(resolve(root), 'updates', id)
}

function validateLease(lease) {
  if (!lease || !uuid.test(lease.id) || !uuid.test(lease.nonce))
    throw failure('invalid-transaction-lease')
  pid(lease.ownerPid)
}

function validateIdentity(value, root) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !uuid.test(value.id) ||
    !uuid.test(value.nonce) ||
    value.root !== resolve(root) ||
    !isAbsolute(value.application ?? '') ||
    !isAbsolute(value.profileHome ?? '') ||
    !hash.test(value.sourceReceiptSha256) ||
    !hash.test(value.targetPendingSha256) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw failure('invalid-transaction-identity')
  pid(value.creatorPid)
  if (!value.desktop || !uuid.test(value.desktop.nonce)) throw failure('invalid-desktop-identity')
  for (const key of ['hostPid', 'launcherPid', 'desktopPid']) pid(value.desktop[key])
  for (const item of [value.source, value.target]) {
    if (
      !item ||
      !hash.test(item.suiteSha256) ||
      !hash.test(item.enhancementSha256) ||
      !hash.test(item.artifactSha256) ||
      typeof item.suiteVersion !== 'string' ||
      typeof item.officialVersion !== 'string'
    )
      throw failure('invalid-transaction-release')
  }
  return value
}

function validateState(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    ![...Object.keys(successors), ...terminal].includes(value.stage) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !Array.isArray(value.history) ||
    value.history.length > 16
  )
    throw failure('invalid-transaction-state')
  pid(value.ownerPid)
  return value
}

async function readRecord(root, reference) {
  if (!reference || !uuid.test(reference.id) || !uuid.test(reference.nonce))
    throw failure('invalid-transaction-reference')
  const dir = updateTransactionDirectory(root, reference.id)
  await directory(join(root, 'updates'))
  await directory(dir)
  const identity = validateIdentity(await json(join(dir, 'identity.json')), root)
  if (identity.id !== reference.id || identity.nonce !== reference.nonce)
    throw failure('transaction-ownership-changed')
  const state = validateState(await json(join(dir, 'state.json')))
  return { ...identity, ...state }
}

/** Read a durable transaction without reading any private Host control credentials. */
export async function readUpdateTransaction(root, reference) {
  const pointer = reference ?? (await json(join(root, pointerName), true))
  if (pointer === null) return null
  return readRecord(root, pointer)
}

function statePart(record) {
  const {
    stage,
    revision,
    ownerPid,
    updatedAt,
    history,
    handoffDeadline,
    shutdown,
    launchClaim,
    launch,
    failure: issue,
  } = record
  return {
    schemaVersion: 1,
    stage,
    revision,
    ownerPid,
    updatedAt,
    history,
    ...(handoffDeadline ? { handoffDeadline } : {}),
    ...(shutdown ? { shutdown } : {}),
    ...(launchClaim ? { launchClaim } : {}),
    ...(launch ? { launch } : {}),
    ...(issue ? { failure: issue } : {}),
  }
}

async function saveState(root, record, stage, details = {}) {
  const updatedAt = new Date().toISOString()
  const next = {
    ...statePart(record),
    ...details,
    stage,
    revision: record.revision + 1,
    updatedAt,
    history: [...record.history, { stage, at: updatedAt }],
  }
  validateState(next)
  await write(join(updateTransactionDirectory(root, record.id), 'state.json'), next)
  return { ...record, ...next }
}

async function currentOwner(root, lease) {
  validateLease(lease)
  const lock = await json(join(root, suiteLockName), true)
  if (lock?.id !== lease.id || lock?.nonce !== lease.nonce || lock.kind !== 'update')
    throw failure('transaction-ownership-changed')
  return readRecord(root, lease)
}

async function recoverLock(root, { isAlive = updateProcessAlive, now = Date.now } = {}) {
  const path = join(root, suiteLockName)
  const lock = await json(path, true)
  if (lock === null) {
    // The creator writes identity/state before publishing the Suite lock. A
    // process crash in that narrow window still leaves an owned attempt; do
    // not let a later Desktop launch silently pass it.
    const pointer = await json(join(root, pointerName), true)
    if (pointer === null) return
    const orphan = await readRecord(root, pointer)
    if (terminal.has(orphan.stage)) return
    if (isAlive(orphan.ownerPid)) throw failure('update-in-progress')
    await saveState(root, orphan, 'failed', {
      failure: { code: 'owner-exited', stage: orphan.stage },
    })
    return
  }
  if (!uuid.test(lock.id) || !uuid.test(lock.nonce)) throw failure('invalid-suite-lock')
  if (lock.kind === 'launch' || lock.kind === 'maintenance') {
    if (isAlive(pid(lock.pid)))
      throw failure(
        lock.kind === 'launch' ? 'suite-launch-in-progress' : 'suite-update-in-progress',
      )
    await removeOwned(path, lock)
    return
  }
  if (lock.kind !== 'update') throw failure('invalid-suite-lock')
  const record = await readRecord(root, lock)
  if (!terminal.has(record.stage)) {
    const waitingForRunner =
      record.stage === 'handoff' &&
      Number.isFinite(Date.parse(record.handoffDeadline)) &&
      now() <= Date.parse(record.handoffDeadline)
    if (waitingForRunner || isAlive(record.ownerPid)) throw failure('update-in-progress')
    await saveState(root, record, 'failed', {
      failure: { code: 'owner-exited', stage: record.stage },
    })
  }
  // Acquisition can lose its process after reserving the Suite and before
  // publishing this pointer. Recovery must retain that attempt's identity.
  await write(join(root, pointerName), { id: record.id, nonce: record.nonce })
  await removeOwned(path, lock)
}

/**
 * Reserve the whole Suite for a verified enhancement transaction. Dead owners
 * are recorded as failures; the same failed pending plan is never retried here.
 */
export async function acquireUpdateTransaction(root, options) {
  return withGate(root, async () => {
    await recoverLock(root, options)
    const previous = await readUpdateTransaction(root)
    if (
      previous &&
      previous.targetPendingSha256 === options.targetPendingSha256 &&
      terminal.has(previous.stage)
    )
      throw failure('transaction-already-attempted')
    const id = randomUUID(),
      nonce = randomUUID(),
      createdAt = new Date().toISOString(),
      ownerPid = pid(options.ownerPid ?? process.pid)
    const identity = validateIdentity(
      {
        schemaVersion: 1,
        id,
        nonce,
        root: resolve(root),
        application: resolve(options.application),
        profileHome: resolve(options.profileHome),
        sourceReceiptSha256: options.sourceReceiptSha256,
        targetPendingSha256: options.targetPendingSha256,
        source: options.source,
        target: options.target,
        desktop: options.desktop,
        creatorPid: ownerPid,
        createdAt,
      },
      root,
    )
    const updates = join(root, 'updates')
    await mkdir(updates, { recursive: true, mode: 0o700 })
    await directory(updates)
    const dir = updateTransactionDirectory(root, id)
    await mkdir(dir, { mode: 0o700 })
    await write(join(dir, 'identity.json'), identity, true)
    await write(
      join(dir, 'state.json'),
      {
        schemaVersion: 1,
        revision: 0,
        stage: 'acquired',
        ownerPid,
        updatedAt: createdAt,
        history: [{ stage: 'acquired', at: createdAt }],
      },
      true,
    )
    await write(join(root, suiteLockName), { kind: 'update', id, nonce, pid: ownerPid }, true)
    await write(join(root, pointerName), { id, nonce })
    return { id, nonce, ownerPid }
  })
}

/** Advance one owned transaction along its ordered durable stages. */
export async function transitionUpdateTransaction(root, lease, stage, details = {}) {
  return withGate(root, async () => {
    const record = await currentOwner(root, lease)
    if (record.ownerPid !== lease.ownerPid) throw failure('transaction-owner-changed')
    if (!successors[record.stage]?.includes(stage)) throw failure('invalid-transaction-transition')
    // Only these fields are mutable through the stage API; receipt and target
    // identities stay in the exclusive, immutable identity.json file.
    if (Object.keys(details).some((key) => !['launch'].includes(key)))
      throw failure('invalid-transaction-details')
    return saveState(root, record, stage, details)
  })
}

/** Offer a bounded ownership transfer; a caller's death cannot reopen this lease early. */
export async function handoffUpdateTransaction(root, lease, { timeoutMs = 30_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw failure('invalid-handoff-timeout')
  return withGate(root, async () => {
    const record = await currentOwner(root, lease)
    if (record.ownerPid !== lease.ownerPid || record.stage !== 'acquired')
      throw failure('invalid-transaction-handoff')
    return saveState(root, record, 'handoff', {
      handoffDeadline: new Date(Date.now() + timeoutMs).toISOString(),
    })
  })
}

/** Claim a single valid handoff; two runner processes cannot own the same update. */
export async function claimUpdateTransaction(root, lease, { ownerPid = process.pid } = {}) {
  return withGate(root, async () => {
    const record = await currentOwner(root, lease)
    if (
      record.stage !== 'handoff' ||
      !Number.isFinite(Date.parse(record.handoffDeadline)) ||
      Date.now() > Date.parse(record.handoffDeadline)
    )
      throw failure('transaction-handoff-expired')
    await saveState(root, record, 'waiting-exit', { ownerPid: pid(ownerPid) })
    return { id: record.id, nonce: record.nonce, ownerPid }
  })
}

/** Persist the launcher's clean shutdown observation; PID exit remains a separate requirement. */
export async function acknowledgeUpdateShutdown(root, lease, acknowledgment) {
  return withGate(root, async () => {
    const record = await currentOwner(root, lease)
    if (!['handoff', 'waiting-exit'].includes(record.stage) || acknowledgment.clean !== true)
      throw failure('clean-shutdown-unconfirmed')
    for (const key of ['hostPid', 'launcherPid', 'desktopPid'])
      if (acknowledgment[key] !== record.desktop[key]) throw failure('shutdown-process-mismatch')
    if (record.shutdown) throw failure('shutdown-already-acknowledged')
    return saveState(root, record, record.stage, {
      shutdown: {
        clean: true,
        hostPid: record.desktop.hostPid,
        launcherPid: record.desktop.launcherPid,
        desktopPid: record.desktop.desktopPid,
        acknowledgedAt: new Date().toISOString(),
      },
    })
  })
}

/** Preserve one final outcome and release only this transaction's Suite reservation. */
export async function finishUpdateTransaction(root, lease, { stage, failure: issue } = {}) {
  if (!terminal.has(stage)) throw failure('invalid-transaction-outcome')
  return withGate(root, async () => {
    const record = await currentOwner(root, lease)
    if (record.ownerPid !== lease.ownerPid) throw failure('transaction-owner-changed')
    if (terminal.has(record.stage)) throw failure('transaction-already-finished')
    if (stage === 'succeeded' && record.stage !== 'confirming')
      throw failure('installation-health-unconfirmed')
    if (stage === 'cancelled' && !['acquired', 'handoff', 'waiting-exit'].includes(record.stage))
      throw failure('transaction-cannot-cancel')
    if (issue && !/^[a-z][a-z0-9-]{0,95}$/u.test(issue))
      throw failure('invalid-transaction-failure')
    const next = await saveState(root, record, stage, {
      ...(stage === 'failed'
        ? { failure: { code: issue ?? 'update-failed', stage: record.stage } }
        : {}),
    })
    await removeOwned(join(root, suiteLockName), lease)
    return next
  })
}

/**
 * Hold the Suite gate through ordinary Desktop spawn and launch-record writing.
 * A runner's tagged start joins its reservation once and leaves it held until
 * health confirmation. Call release in a finally block.
 */
export async function acquireSuiteLaunch(root, { transactionId, nonce, ...options } = {}) {
  return withGate(root, async () => {
    if (transactionId !== undefined || nonce !== undefined) {
      const record = await currentOwner(root, { id: transactionId, nonce, ownerPid: process.pid })
      if (!['starting', 'confirming'].includes(record.stage) || record.launchClaim)
        throw failure('transaction-launch-already-claimed')
      await saveState(root, record, record.stage, {
        launchClaim: { pid: process.pid, at: new Date().toISOString() },
      })
      return { release: async () => {} }
    }
    await recoverLock(root, options)
    const lease = { kind: 'launch', id: randomUUID(), nonce: randomUUID(), pid: process.pid }
    await write(join(root, suiteLockName), lease, true)
    let released = false
    return {
      release: async () => {
        if (released) return
        await withGate(root, () => removeOwned(join(root, suiteLockName), lease))
        released = true
      },
    }
  })
}

/** Fail unless the caller holds this Suite's active transaction, for installer joins. */
export async function assertUpdateTransaction(root, lease, stages = ['installing']) {
  return withGate(root, async () => {
    const record = await currentOwner(root, lease)
    if (record.ownerPid !== lease.ownerPid || !stages.includes(record.stage))
      throw failure('transaction-stage-mismatch')
    return record
  })
}

/**
 * Reserve Suite files for prepare/cancel/refresh, or join the runner's install
 * stage. A stopped launch's refresh may reuse its own short launch reservation.
 */
export async function acquireSuiteMaintenance(root, { transaction, allowLaunch = false } = {}) {
  return withGate(root, async () => {
    if (transaction) {
      const record = await currentOwner(root, transaction)
      if (record.ownerPid !== transaction.ownerPid || record.stage !== 'installing')
        throw failure('transaction-stage-mismatch')
      return { release: async () => {} }
    }
    const current = await json(join(root, suiteLockName), true)
    if (allowLaunch && current?.kind === 'launch' && current.pid === process.pid)
      return { release: async () => {} }
    await recoverLock(root)
    const lease = { kind: 'maintenance', id: randomUUID(), nonce: randomUUID(), pid: process.pid }
    await write(join(root, suiteLockName), lease, true)
    let released = false
    return {
      release: async () => {
        if (released) return
        await withGate(root, () => removeOwned(join(root, suiteLockName), lease))
        released = true
      },
    }
  })
}
