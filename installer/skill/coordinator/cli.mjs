/** Explicit coordinator commands and owned Hook configuration; importing this module performs no work. */
import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { watch as watchFile } from 'node:fs'
import { execFile } from 'node:child_process'
import {
  createOwnedHooks,
  mergeOwnedHooks,
  upgradeOwnedHooks,
  restoreHooksBackup,
  readHookInput,
  canonicalPath,
} from './hooks.mjs'
import { registerDispatchTask } from './dispatch-registration.mjs'
import { ProjectStore } from './state.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const MAX_FILE_BYTES = 1024 * 1024
const fail = () => {
  throw new Error('coordinator-command-failed')
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\0\r\n]/.test(value)
const absolute = (value) => text(value) && isAbsolute(value)
const privateFields = new Set([
  'authorization',
  'acceptance',
  'summary',
  'prompt',
  'text',
  'messages',
  'questions',
  'reviewInstructions',
  'evidence',
  'checkpoint',
  'binding',
  'cursor',
])

function parseArgs(argv, env) {
  const [command, ...rest] = argv
  const allowed = {
    init: ['file'],
    bind: ['project', 'work', 'task', 'operation'],
    status: ['project'],
    inspect: ['project'],
    pause: ['project', 'reason'],
    resume: ['project', 'reason'],
    reconcile: ['project'],
    watch: ['project', 'watch-token'],
    'start-watch': ['project'],
    'stop-watch': ['project'],
    ack: ['project', 'intent', 'epoch'],
    apply: ['project', 'file'],
    'review-action': ['project', 'file'],
    hook: [],
    'install-hooks': ['shell', 'node'],
    setup: ['shell', 'node'],
    'remove-hooks': [],
  }
  if (!Object.hasOwn(allowed, command)) fail()
  const flags = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2),
      value = rest[i + 1]
    if (
      !rest[i]?.startsWith('--') ||
      ![...allowed[command], 'root', 'codex-home'].includes(key) ||
      Object.hasOwn(flags, key) ||
      !text(value) ||
      value.startsWith('--')
    )
      fail()
    flags[key] = value
  }
  const requestedHome = flags['codex-home'] ?? env.CODEX_HOME ?? join(homedir(), '.codex')
  const requestedRoot = flags.root ?? join(requestedHome, 'opl-dsh-coordinator')
  if (!absolute(requestedHome) || !absolute(requestedRoot)) fail()
  const codexHome = resolve(requestedHome),
    root = resolve(requestedRoot)
  if (
    [
      'inspect',
      'bind',
      'pause',
      'resume',
      'reconcile',
      'watch',
      'start-watch',
      'stop-watch',
      'ack',
      'apply',
      'review-action',
    ].includes(command) &&
    !flags.project
  )
    fail()
  if (['init', 'apply', 'review-action'].includes(command) && !flags.file) fail()
  if (command === 'bind' && (!flags.work || !flags.task || !flags.operation)) fail()
  if (
    command === 'ack' &&
    (!flags.intent ||
      !/^[1-9]\d*$/.test(flags.epoch ?? '') ||
      !Number.isSafeInteger(Number(flags.epoch)))
  )
    fail()
  if (command === 'install-hooks' && !['git-bash', 'powershell'].includes(flags.shell)) fail()
  if (flags.node && !absolute(flags.node)) fail()
  return { command, flags, root, codexHome }
}

async function readText(filename, optional = false) {
  try {
    const stat = await lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) fail()
    const bytes = await readFile(filename)
    if (bytes.length > MAX_FILE_BYTES) fail()
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null
    throw error
  }
}

async function atomicWrite(filename, contents) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = filename + '.' + randomUUID() + '.tmp'
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    // Windows readers can briefly retain a handle while the replacement is published.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, filename)
        break
      } catch (error) {
        if (
          process.platform !== 'win32' ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
          attempt >= 49
        )
          throw error
        await delay(5)
      }
    }
  } finally {
    await handle.close()
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

const jsonText = (value) => JSON.stringify(value, null, 2) + '\n'
const keysOnly = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key))

function reviewRequest(value) {
  if (
    !keysOnly(value, [
      'kind',
      'reviewRunId',
      'consumerId',
      'claimEpoch',
      'authorityEpoch',
      'decision',
      'noteFile',
    ]) ||
    !['review', 'consume'].includes(value.kind) ||
    !text(value.reviewRunId) ||
    !text(value.consumerId) ||
    !Number.isSafeInteger(value.claimEpoch) ||
    value.claimEpoch < 0 ||
    !Number.isSafeInteger(value.authorityEpoch) ||
    value.authorityEpoch < 1 ||
    !['accepted', 'changes_requested', undefined].includes(value.decision) ||
    (value.noteFile !== undefined && !absolute(value.noteFile)) ||
    (value.kind === 'review' && (!value.decision || !value.noteFile))
  )
    throw new Error('invalid-review-action')
  return value
}

const diagnosticCodes = new Set([
  'COMPLETED',
  'CONFLICT',
  'CORRUPT',
  'INCOMPLETE',
  'INVALID',
  'LIMIT',
  'LOCK_BUSY',
  'LOCK_CORRUPT',
  'NOT_FOUND',
  'PAUSED',
  'REVIEW_BUSY',
  'STALE_CLAIM',
  'STALE_EPOCH',
  'STALE_INTENT',
  'STALE_OBSERVATION',
  'STALE_REVIEW',
  'STALE_RUN',
  'TARGET_MISMATCH',
  'UNSUPPORTED_SCHEMA',
  'ENOENT',
  'EACCES',
  'EPERM',
  'EBUSY',
  'EEXIST',
  'ENOTDIR',
])
const diagnosticMessages = new Set([
  'invalid-review-action',
  'review-external-session-required',
  'review-feedback-unavailable',
  'review-note-outside-project',
  'review-runtime-changed',
  'review-runtime-unknown',
  'review-task-unavailable',
  'stale-continuation',
  'thread-already-registered',
  'unsupported-lifecycle-event',
  'process-command-failed',
  'legacy-hook-lock-present',
])

function diagnosticCode(error) {
  if (diagnosticCodes.has(error?.code)) return error.code
  if (diagnosticMessages.has(error?.message)) return error.message
  return null
}

function validateSettings(value, codexHome) {
  if (
    !keysOnly(value, [
      'schemaVersion',
      'codexHome',
      'controlPath',
      'queue',
      'feedbackWatchPaths',
      'watchMode',
      'nodePath',
    ]) ||
    value.schemaVersion !== 1 ||
    value.codexHome !== codexHome ||
    !absolute(value.controlPath) ||
    !Array.isArray(value.feedbackWatchPaths) ||
    value.feedbackWatchPaths.length > 32 ||
    !value.feedbackWatchPaths.every(absolute)
  )
    fail()
  if (
    !['auto', 'manual'].includes(value.watchMode ?? 'auto') ||
    !(value.nodePath === undefined || value.nodePath === null || absolute(value.nodePath))
  )
    fail()
  // Older installations stored a queue snapshot here. DSH's public settings now own it.
  const { queue: _legacyQueue, ...current } = value
  return {
    ...current,
    watchMode: value.watchMode ?? 'auto',
    nodePath: value.nodePath ?? (process.versions.electron ? null : process.execPath),
  }
}

async function loadSettings(root, codexHome) {
  const saved = await readText(join(root, 'settings.json'), true)
  return saved === null
    ? {
        schemaVersion: 1,
        codexHome,
        controlPath: fileURLToPath(new URL('../control.mjs', import.meta.url)),
        feedbackWatchPaths: [],
        watchMode: 'auto',
        nodePath: process.versions.electron ? null : process.execPath,
      }
    : validateSettings(JSON.parse(saved), codexHome)
}

function withConnection(settings, connection) {
  if (connection === undefined) return settings
  if (!keysOnly(connection, ['controlPath', 'feedbackWatchPaths', 'watchMode'])) fail()
  const next = { ...settings }
  if (Object.hasOwn(connection, 'controlPath')) next.controlPath = connection.controlPath
  if (Object.hasOwn(connection, 'feedbackWatchPaths'))
    next.feedbackWatchPaths = connection.feedbackWatchPaths
  if (Object.hasOwn(connection, 'watchMode')) next.watchMode = connection.watchMode
  return validateSettings(next, settings.codexHome)
}

async function withHookLock(root, action) {
  const store = new ProjectStore({ root: join(root, 'projects') })
  return store.transaction('__hook-install__', async () => {
    let legacy
    try {
      legacy = await lstat(join(root, 'hooks-install.lock'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    // An old empty lock records no owner; its age or contents cannot establish exit.
    if (legacy) throw new Error('legacy-hook-lock-present')
    return action()
  })
}

async function hookMetadata(root, codexHome) {
  const original = await readText(join(root, 'hooks-installation.json'), true)
  if (original === null) return null
  const metadata = JSON.parse(original)
  if (
    !object(metadata) ||
    metadata.schemaVersion !== 1 ||
    metadata.codexHome !== codexHome ||
    metadata.hooksPath !== join(codexHome, 'hooks.json') ||
    !Array.isArray(metadata.backups) ||
    metadata.backups.length < 1 ||
    metadata.backups.length > 32
  )
    fail()
  // The owner helper validates backup definitions without exposing their original contents.
  for (const backup of metadata.backups) restoreHooksBackup(null, backup)
  return metadata
}

async function installHooks({ root, codexHome, flags }) {
  return withHookLock(root, async () => {
    const hooksPath = join(codexHome, 'hooks.json'),
      metadataPath = join(root, 'hooks-installation.json')
    const current = await readText(hooksPath, true),
      previous = await hookMetadata(root, codexHome)
    const owned = createOwnedHooks({
      nodePath: flags.node ?? process.execPath,
      scriptPath,
      args: ['hook', '--root', root, '--codex-home', codexHome],
      windowsShell: flags.shell,
    })
    const last = previous?.backups.at(-1)
    const merged = last
      ? upgradeOwnedHooks(current, last.owned, owned)
      : mergeOwnedHooks(current, owned)
    if (merged.status === 'needs-repair')
      return {
        status: 'needs-repair',
        reason: 'installed-hooks-customized-missing-or-duplicated',
        hooksPath,
        requiresTrust: false,
        next: 'review-existing-hooks-in-codex',
      }
    if (merged.status === 'unchanged')
      return { status: 'unchanged', hooksPath, hookCount: 7, requiresTrust: true }
    const backups = [...(previous?.backups ?? []), merged.backup]
    if (backups.length > 32) fail()
    if ((await readText(hooksPath, true)) !== current) fail()
    await atomicWrite(metadataPath, jsonText({ schemaVersion: 1, codexHome, hooksPath, backups }))
    if ((await readText(hooksPath, true)) !== current) fail()
    await atomicWrite(hooksPath, merged.text)
    return { status: 'installed', hooksPath, hookCount: 7, requiresTrust: true }
  })
}

async function probeNode(candidate) {
  if (candidate !== 'node' && (!absolute(candidate) || !/[/\\]node(?:\.exe)?$/i.test(candidate)))
    return null
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((done) => {
    execFile(
      candidate,
      [
        '-e',
        'process.stdout.write(JSON.stringify({path:process.execPath,electron:!!process.versions.electron}))',
      ],
      { env, windowsHide: true, shell: false, timeout: 5000, maxBuffer: 32768, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return done(null)
        try {
          done(JSON.parse(stdout))
        } catch {
          done(null)
        }
      },
    )
  })
}

/**
 * Resolve a real Node executable without launching an Electron app as a detector.
 * @param {object} options Saved path, explicit override and bounded version probe.
 * @returns {Promise<string|null>} Verified Node path, or null without changing Hooks.
 */
export async function resolveNodeRuntime({ nodePath, explicitPath, probe = probeNode }) {
  const candidates = explicitPath
    ? [explicitPath]
    : [...new Set([nodePath, 'node'].filter(Boolean))]
  for (const candidate of candidates) {
    if (candidate !== 'node' && (!absolute(candidate) || !/[/\\]node(?:\.exe)?$/i.test(candidate)))
      continue
    const result = await probe(candidate)
    if (
      result?.electron === false &&
      absolute(result.path) &&
      /[/\\]node(?:\.exe)?$/i.test(result.path)
    )
      return result.path
  }
  return null
}

/** Install owned Hooks with verified Node, or return a missing-runtime guide without changing them. */
export async function setupCoordinator({ root, codexHome, flags, nodeProbe }) {
  const settings = await loadSettings(root, codexHome)
  settings.nodePath = await resolveNodeRuntime({
    nodePath: settings.nodePath,
    explicitPath: flags.node,
    probe: nodeProbe,
  })
  if (!settings.nodePath)
    return {
      status: 'unavailable',
      reason: 'node-runtime-required',
      requiresTrust: false,
      next: 'install-node-and-run-setup',
    }
  const installed = await installHooks({
    root,
    codexHome,
    flags: {
      ...flags,
      node: settings.nodePath,
    },
  })
  if (installed.status === 'needs-repair') return installed
  await atomicWrite(join(root, 'settings.json'), jsonText(settings))
  const statePath = join(root, 'setup-state.json')
  JSON.parse((await readText(statePath, true)) ?? '{}')
  const state = {
    schemaVersion: 1,
    hooksInstalled: true,
    requiresTrust: true,
    trustStatus: 'managed-by-codex',
    hooksPath: join(codexHome, 'hooks.json'),
    settingsHint: '打开 Codex 设置 → 钩子，审核并点击“全部信任”后完成启用。',
    updatedAt: new Date().toISOString(),
  }
  await atomicWrite(statePath, jsonText(state))
  return { ...installed, setupState: state, next: 'open-codex-hooks-settings' }
}

async function removeHooks({ root, codexHome }) {
  return withHookLock(root, async () => {
    const metadata = await hookMetadata(root, codexHome)
    if (!metadata) return { status: 'not-installed' }
    const current = await readText(metadata.hooksPath, true)
    let restored = current
    for (const backup of [...metadata.backups].reverse())
      restored = restoreHooksBackup(restored, backup).text
    if ((await readText(metadata.hooksPath, true)) !== current) fail()
    if (restored === null) {
      if (current !== null) await unlink(metadata.hooksPath)
    } else if (restored !== current) await atomicWrite(metadata.hooksPath, restored)
    await rename(
      join(root, 'hooks-installation.json'),
      join(root, 'hooks-removed-' + randomUUID() + '.json'),
    )
    return { status: 'removed', hooksPath: metadata.hooksPath }
  })
}

const pick = (value, fields) =>
  Object.fromEntries(
    fields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
  )

function inspectProject(state) {
  return {
    ...pick(state, [
      'projectId',
      'threadId',
      'cwd',
      'mode',
      'authorityEpoch',
      'revision',
      'progressRevision',
    ]),
    evidenceTrust: 'untrusted-data; verify evidence and checkpoints before acting',
    workItems: state.workItems.map((work) =>
      pick(work, [
        'workId',
        'dependsOn',
        'required',
        'status',
        'taskId',
        'operationId',
        'acceptance',
        'evidence',
      ]),
    ),
    reviews: state.reviews.map((review) => ({
      ...pick(review, [
        'reviewRunId',
        'consumerId',
        'claimEpoch',
        'deliveryId',
        'workId',
        'taskId',
        'operationId',
        'runId',
        'turnId',
        'authorityEpoch',
        'status',
        'result',
        'acceptance',
        'evidence',
      ]),
      actions: (review.actions ?? []).map((action) =>
        pick(action, [
          'actionId',
          'kind',
          'status',
          'reviewRunId',
          'consumerId',
          'claimEpoch',
          'authorityEpoch',
          'runId',
          'turnId',
          'workId',
          'taskId',
          'operationId',
          'deliveryId',
          'createdAt',
          'updatedAt',
        ]),
      ),
      ...(review.checkpoint
        ? {
            checkpoint: {
              ...pick(review.checkpoint, ['artifactRevision', 'reviewWritten', 'consumed']),
              checks: review.checkpoint.checks.map((check) =>
                pick(check, ['id', 'result', 'evidence']),
              ),
            },
          }
        : {}),
    })),
    runtime: pick(state.runtime, [
      'status',
      'runId',
      'turnId',
      'pid',
      'processBirth',
      'terminal',
      'backendVersion',
    ]),
    intents: state.intents.map((intent) =>
      pick(intent, [
        'intentId',
        'threadId',
        'cwd',
        'status',
        'via',
        'authorityEpoch',
        'progressRevision',
      ]),
    ),
    feedback: state.feedback.map((entry) =>
      pick(entry, [
        'deliveryId',
        'taskId',
        'workId',
        'state',
        'status',
        'claimEpoch',
        'consumerId',
      ]),
    ),
  }
}

async function discoverFeedbackSource(filename) {
  try {
    const config = JSON.parse(await readText(filename))
    // The installed Skill owns this public home path; no other config fields leave this function.
    if (!absolute(config.home)) return []
    const directory = join(config.home, 'storages'),
      stat = await lstat(directory)
    return stat.isDirectory() && !stat.isSymbolicLink() ? [directory] : []
  } catch {
    return []
  }
}

async function defaultLaunch(options) {
  for (const url of [
    new URL('../windows-lifecycle.mjs', import.meta.url),
    new URL('../../windows-lifecycle.mjs', import.meta.url),
  ]) {
    try {
      const stat = await lstat(fileURLToPath(url))
      if (!stat.isFile()) continue
      return (await import(url.href)).launchIndependent(options)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  fail()
}

function defaultProbe(pid) {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return error.code === 'ESRCH' ? 'exited' : 'unknown'
  }
}

const watcherToken = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const validPid = (value) => Number.isSafeInteger(value) && value > 0
const watcherFile = (root) => join(root, 'watcher.json')
const stopFile = (root, token) => join(root, 'watch-stop-' + token + '.json')

async function readWatcher(root, codexHome) {
  const bytes = await readText(watcherFile(root), true)
  if (bytes === null) return null
  const value = JSON.parse(bytes)
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.codexHome !== codexHome ||
    value.projectId !== '__all__' ||
    !watcherToken(value.token) ||
    !(value.pid === null || validPid(value.pid)) ||
    !absolute(value.nodePath)
  )
    fail()
  return value
}

async function ensureWatcher({
  root,
  codexHome,
  settings,
  store,
  launch,
  probe,
  automatic = false,
}) {
  if (automatic && settings.watchMode === 'manual') return { status: 'manual' }
  const nodePath = settings.nodePath
  if (!absolute(nodePath) || !/[/\\]node(?:\.exe)?$/i.test(nodePath))
    return { status: 'unavailable', reason: 'node-path-required' }
  try {
    return await store.transaction('__watcher-launch__', async () => {
      const prior = await readWatcher(root, codexHome)
      if (prior) {
        const readyText = await readText(join(root, 'watcher-ready.json'), true)
        const ready = readyText ? JSON.parse(readyText) : null
        if (prior.pid === null && ready?.token === prior.token && validPid(ready.pid)) {
          prior.pid = ready.pid
          await atomicWrite(watcherFile(root), jsonText(prior))
        }
        // A live or inaccessible PID can belong to an old instance; neither grants a second launch.
        if (prior.pid === null) return { status: 'uncertain', reason: 'watch-launch-unconfirmed' }
        const alive = await probe(prior.pid)
        if (alive !== 'exited') {
          return {
            status:
              alive === 'alive' && ready?.token === prior.token && ready.pid === prior.pid
                ? 'running'
                : 'starting',
            pid: prior.pid,
          }
        }
      }
      const token = randomUUID(),
        record = { schemaVersion: 1, projectId: '__all__', codexHome, token, pid: null, nodePath }
      await atomicWrite(watcherFile(root), jsonText(record))
      const started = await launch({
        command: nodePath,
        args: [
          scriptPath,
          'watch',
          '--project',
          '__all__',
          '--watch-token',
          token,
          '--root',
          root,
          '--codex-home',
          codexHome,
        ],
        label: 'opl-project-coordinator-watch',
      })
      if (!validPid(started?.pid))
        return { status: 'uncertain', reason: 'watch-launch-unconfirmed' }
      await atomicWrite(watcherFile(root), jsonText({ ...record, pid: started.pid }))
      return { status: 'starting', pid: started.pid }
    })
  } catch {
    return { status: 'unavailable', reason: 'watch-start-unavailable' }
  }
}

async function watcherStatus(root, codexHome, probe) {
  const current = await readWatcher(root, codexHome)
  if (!current) return { status: 'not-started' }
  if (current.pid === null) return { status: 'uncertain' }
  const alive = await probe(current.pid)
  if (alive === 'exited') return { status: 'stopped', pid: current.pid }
  const readyText = await readText(join(root, 'watcher-ready.json'), true)
  const ready = readyText ? JSON.parse(readyText) : null
  return {
    status:
      alive === 'alive' && ready?.token === current.token && ready.pid === current.pid
        ? 'running'
        : 'unknown',
    pid: current.pid,
  }
}

async function stopWatcher(root, codexHome) {
  const watcher = await readWatcher(root, codexHome)
  if (!watcher) return { status: 'not-started' }
  await atomicWrite(stopFile(root, watcher.token), jsonText({ token: watcher.token }))
  return { status: 'stopping', pid: watcher.pid }
}

async function runWatcher(coordinator, parsed) {
  const { root, codexHome, flags } = parsed,
    token = flags['watch-token']
  if (!watcherToken(token) || flags.project !== '__all__') fail()
  const record = await readWatcher(root, codexHome)
  if (!record || record.token !== token || (record.pid !== null && record.pid !== process.pid))
    fail()
  const controller = new AbortController(),
    abort = () => controller.abort()
  const checkStop = async () => {
    const requested = await readText(stopFile(root, token), true)
    if (
      (requested !== null && JSON.parse(requested).token === token) ||
      (await loadSettings(root, codexHome)).watchMode === 'manual'
    )
      abort()
  }
  const watcher = watchFile(root, () => {
    checkStop().catch(abort)
  })
  watcher.on('error', abort)
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    await atomicWrite(join(root, 'watcher-ready.json'), jsonText({ token, pid: process.pid }))
    await checkStop()
    return controller.signal.aborted
      ? { status: 'stopped' }
      : await coordinator.watch({ projectId: undefined, signal: controller.signal })
  } finally {
    watcher.close()
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    await atomicWrite(join(root, 'watcher-exit.json'), jsonText({ token, pid: process.pid }))
  }
}

/**
 * Execute one CLI request; errors expose only a fixed diagnostic and an optional known short code.
 * @param {string[]} argv Command arguments, without node and filename.
 * @param {object} options Optional runtime constructor, streams and environment.
 * @returns {Promise<number>} Process exit code; Hook stdout contains only the official output JSON or nothing.
 */
export async function main(
  argv = process.argv.slice(2),
  {
    Coordinator,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    launch = defaultLaunch,
    probe = defaultProbe,
    skillConfigPath = fileURLToPath(new URL('../config.json', import.meta.url)),
    nodeProbe,
  } = {},
) {
  try {
    const parsed = parseArgs(argv, env),
      { command, flags, root, codexHome } = parsed
    const emit = (value) =>
      stdout.write(
        JSON.stringify(value, (key, entry) => (privateFields.has(key) ? undefined : entry)) + '\n',
      )
    if (command === 'install-hooks') {
      const settings = await loadSettings(root, codexHome)
      settings.nodePath = await resolveNodeRuntime({
        nodePath: settings.nodePath,
        explicitPath: flags.node,
        probe: nodeProbe,
      })
      if (!settings.nodePath) fail()
      flags.node = settings.nodePath
      const installed = await installHooks(parsed)
      if (installed.status !== 'needs-repair')
        await atomicWrite(join(root, 'settings.json'), jsonText(settings))
      emit(installed)
      return 0
    }
    if (command === 'setup') {
      emit(await setupCoordinator({ ...parsed, nodeProbe }))
      return 0
    }
    if (command === 'remove-hooks') {
      emit(await removeHooks(parsed))
      return 0
    }
    let settings = await loadSettings(root, codexHome),
      spec
    if (command === 'init') {
      const plan = JSON.parse(await readText(resolve(flags.file)))
      if (!object(plan)) fail()
      const { connection, ...project } = plan
      settings = withConnection(settings, connection)
      if (
        !Object.hasOwn(connection ?? {}, 'feedbackWatchPaths') &&
        !settings.feedbackWatchPaths.length
      )
        settings.feedbackWatchPaths = await discoverFeedbackSource(skillConfigPath)
      spec = project
    }
    const Runtime = Coordinator ?? (await import('./runtime.mjs')).Coordinator
    const coordinator = new Runtime({
      root,
      codexHome,
      controlPath: settings.controlPath,
      feedbackWatchPaths: settings.feedbackWatchPaths,
    })
    if (command === 'hook') {
      const input = await readHookInput(stdin)
      if (!input.ok) return 0
      const result = await coordinator.hook(input.observation)
      if (result?.output !== undefined && result.output !== null)
        stdout.write(JSON.stringify(result.output) + '\n')
      const projects = await coordinator.status()
      const threadId = input.observation.agentId ?? input.observation.sessionId
      if (
        Array.isArray(projects) &&
        projects.some(
          (state) =>
            state.mode !== 'completed' &&
            state.threadId === threadId &&
            canonicalPath(state.cwd) === canonicalPath(input.observation.cwd),
        )
      )
        await ensureWatcher({
          root,
          codexHome,
          settings,
          store: coordinator.store,
          launch,
          probe,
          automatic: true,
        })
      return 0
    }
    let result
    switch (command) {
      case 'init':
        result = await coordinator.init(spec)
        await atomicWrite(join(root, 'settings.json'), jsonText(settings))
        result = {
          ...result,
          watchStatus: settings.feedbackWatchPaths.length
            ? 'metadata-source-configured'
            : 'no-feedback-metadata-source',
          watcher: await ensureWatcher({
            root,
            codexHome,
            settings,
            store: coordinator.store,
            launch,
            probe,
            automatic: true,
          }),
        }
        break
      case 'bind': {
        const state = await coordinator.status(flags.project)
        if (state.threadId !== env.CODEX_THREAD_ID)
          throw new Error('coordinator-chief-thread-required')
        result = await registerDispatchTask({
          codexHome,
          threadId: env.CODEX_THREAD_ID,
          cwd: state.cwd,
          projectId: flags.project,
          workId: flags.work,
          taskId: flags.task,
          operationId: flags.operation,
          store: coordinator.store,
        })
        break
      }
      case 'status':
        result = await coordinator.status(flags.project)
        {
          const metadata = {
            watchStatus: settings.feedbackWatchPaths.length
              ? 'metadata-source-configured'
              : 'no-feedback-metadata-source',
            watchMode: settings.watchMode,
            watcher: await watcherStatus(root, codexHome, probe),
          }
          result = Array.isArray(result)
            ? result.map((state) => ({ ...state, ...metadata }))
            : { ...result, ...metadata }
        }
        break
      case 'inspect':
        stdout.write(
          JSON.stringify(inspectProject(await coordinator.store.get(flags.project))) + '\n',
        )
        return 0
      case 'start-watch':
        await coordinator.status(flags.project)
        settings.watchMode = 'auto'
        await atomicWrite(join(root, 'settings.json'), jsonText(settings))
        result = await ensureWatcher({
          root,
          codexHome,
          settings,
          store: coordinator.store,
          launch,
          probe,
        })
        break
      case 'stop-watch':
        await coordinator.status(flags.project)
        settings.watchMode = 'manual'
        await atomicWrite(join(root, 'settings.json'), jsonText(settings))
        result = await stopWatcher(root, codexHome)
        break
      case 'pause':
        result = await coordinator.pause(flags.project, flags.reason ?? 'explicit-user-pause')
        break
      case 'resume':
        result = await coordinator.resume(flags.project, flags.reason ?? 'explicit-user-resume')
        break
      case 'reconcile':
        result = await coordinator.reconcile(flags.project)
        break
      case 'ack':
        result = await coordinator.acknowledge(flags.project, flags.intent, Number(flags.epoch))
        break
      case 'apply':
        result = await coordinator.store.apply(
          flags.project,
          JSON.parse(await readText(resolve(flags.file))),
        )
        break
      case 'review-action':
        result = await coordinator.reviewAction(
          flags.project,
          reviewRequest(JSON.parse(await readText(resolve(flags.file)))),
        )
        break
      case 'watch': {
        if (flags['watch-token']) {
          result = await runWatcher(coordinator, parsed)
          break
        }
        const controller = new AbortController(),
          abort = () => controller.abort()
        process.once('SIGINT', abort)
        process.once('SIGTERM', abort)
        try {
          result = await coordinator.watch({ projectId: flags.project, signal: controller.signal })
        } finally {
          process.removeListener('SIGINT', abort)
          process.removeListener('SIGTERM', abort)
        }
        break
      }
      default:
        fail()
    }
    emit(result ?? { status: 'ok' })
    return 0
  } catch (error) {
    const code = diagnosticCode(error)
    stderr.write(
      `协调命令失败${code ? ' [' + code + ']' : ''}；请检查参数、项目状态和已保存配置。\n`,
    )
    return 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    // WMI carries paths in argv; child queue commands still need the selected Codex home.
    process.env.CODEX_HOME = parseArgs(process.argv.slice(2), process.env).codexHome
  } catch {
    /* main owns the bounded CLI diagnostic. */
  }
  process.exitCode = await main()
}
