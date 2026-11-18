/** Bounded metadata adapter for the tested Codex 0.167.0 and 0.169.0 hooks and rollout files. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const SUPPORTED_BACKEND_VERSIONS = new Set(['0.167.0', '0.169.0'])

/** Return whether the exact backend version has a verified Hook and rollout adapter. */
export const supportsBackendVersion = (version) => SUPPORTED_BACKEND_VERSIONS.has(version)
export const HOOK_LIMITS = Object.freeze({
  stdinBytes: 1024 * 1024,
  headerBytes: 64 * 1024,
  lineBytes: 2 * 1024 * 1024,
  readBytes: 4 * 1024 * 1024,
})
const HOOK_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'Interrupt',
  'PreModelRequest',
  'PostModelRequest',
  'SubagentStart',
  'SubagentStop',
])
const ABORT_REASONS = new Set(['interrupted', 'replaced', 'review_ended', 'budget_limited'])
const IGNORED_RECORDS = new Set([
  'response_item',
  'turn_context',
  'compacted',
  'token_usage_record',
  'world_state',
  'retained_context',
  'security_risk_score',
  'dynamic_tools_updated',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
  'realtime_item',
])
const IGNORED_EVENTS = new Set([
  'user_message',
  'agent_message',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'token_count',
  'context_compacted',
  'item_completed',
  'thread_goal_updated',
  'thread_settings_applied',
  'entered_review_mode',
  'exited_review_mode',
  'patch_apply_end',
  'mcp_tool_call_end',
  'web_search_end',
  'image_generation_end',
  'sub_agent_activity',
])
const decoder = new TextDecoder('utf-8', { fatal: true })
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
const validText = (value, max = 32768) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const invalid = (reason) => ({ ok: false, reason })

function continuationMetadata(prompt) {
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > 8192) return undefined
  let value
  try {
    value = JSON.parse(prompt)
  } catch {
    return undefined
  }
  if (
    !isObject(value) ||
    value.type !== 'opl-project-coordinator' ||
    Object.keys(value).some(
      (key) => !['type', 'projectId', 'intentId', 'authorityEpoch', 'instruction'].includes(key),
    ) ||
    !validText(value.projectId, 256) ||
    !value.projectId.trim() ||
    !validId(value.intentId) ||
    !Number.isSafeInteger(value.authorityEpoch) ||
    value.authorityEpoch < 1 ||
    (value.instruction !== undefined && !validText(value.instruction, 2048))
  )
    return undefined
  return {
    projectId: value.projectId,
    intentId: value.intentId,
    authorityEpoch: value.authorityEpoch,
  }
}

/** Parse one hook object and retain only identifiers, paths and lifecycle flags. */
export function parseHookInput(raw) {
  if (!(typeof raw === 'string' || Buffer.isBuffer(raw) || raw instanceof Uint8Array))
    return invalid('invalid-input')
  const bytes = Buffer.from(raw)
  if (bytes.length > HOOK_LIMITS.stdinBytes) return invalid('input-too-large')
  let data
  try {
    data = JSON.parse(decoder.decode(bytes))
  } catch {
    return invalid('invalid-json')
  }
  if (!isObject(data) || !HOOK_EVENTS.has(data.hook_event_name))
    return invalid('unknown-hook-event')
  if (!validId(data.session_id) || !validText(data.cwd)) return invalid('invalid-hook-identity')
  if (data.turn_id != null && !validId(data.turn_id)) return invalid('invalid-turn-id')
  if (data.agent_id != null && !validId(data.agent_id)) return invalid('invalid-agent-id')
  for (const key of ['transcript_path', 'agent_transcript_path']) {
    if (data[key] != null && !validText(data[key])) return invalid('invalid-transcript-path')
  }
  const event = data.hook_event_name
  if (
    [
      'UserPromptSubmit',
      'Stop',
      'Interrupt',
      'PreModelRequest',
      'PostModelRequest',
      'SubagentStop',
    ].includes(event) &&
    !validId(data.turn_id)
  )
    return invalid('missing-turn-id')
  if (event === 'Stop' && typeof data.stop_hook_active !== 'boolean')
    return invalid('invalid-stop-flag')
  if (event === 'PostModelRequest' && !['completed', 'failed', 'cancelled'].includes(data.status))
    return invalid('unknown-request-status')
  if (
    event === 'SessionStart' &&
    !['startup', 'resume', 'clear', 'compact', 'fork'].includes(data.source)
  )
    return invalid('unknown-session-source')
  const continuation = event === 'UserPromptSubmit' ? continuationMetadata(data.prompt) : undefined
  return {
    ok: true,
    observation: {
      event,
      sessionId: data.session_id,
      turnId: data.turn_id ?? null,
      agentId: data.agent_id ?? null,
      transcriptPath: data.transcript_path ?? null,
      agentTranscriptPath: data.agent_transcript_path ?? null,
      cwd: data.cwd,
      source: event === 'SessionStart' ? data.source : null,
      stopHookActive: event === 'Stop' ? data.stop_hook_active : false,
      requestStatus: event === 'PostModelRequest' ? data.status : null,
      ...(continuation ? { continuation } : {}),
    },
  }
}

/** Consume bounded stdin; oversized streams are destroyed without copying their contents. */
export async function readHookInput(stream) {
  const chunks = []
  let length = 0
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk)
      length += bytes.length
      if (length > HOOK_LIMITS.stdinBytes) {
        stream.destroy?.()
        return invalid('input-too-large')
      }
      chunks.push(bytes)
    }
  } catch {
    return invalid('input-read-failed')
  }
  return parseHookInput(Buffer.concat(chunks, length))
}

/** Normalize absolute local paths, including the Windows extended drive-path alias. */
export function canonicalPath(input) {
  if (!validText(input)) throw new Error('invalid-path')
  let value = input.replaceAll('\\', '/')
  if (value.startsWith('//?/')) value = value.slice(4)
  // UNC, device namespaces, alternate streams and Win32 trailing-name aliases are unsupported.
  if (/^[A-Za-z]:\//.test(value)) {
    if (
      value.slice(2).includes(':') ||
      value
        .split('/')
        .slice(1)
        .some((part) => /[. ]$/.test(part) && part !== '.' && part !== '..')
    )
      throw new Error('unsupported-path')
    return path.win32.normalize(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
  }
  if (value.startsWith('//') || !path.posix.isAbsolute(value) || process.platform === 'win32')
    throw new Error('unsupported-path')
  return path.posix.normalize(value).replace(/\/$/, '') || '/'
}

const inside = (parent, child) => child.startsWith(`${parent}/`)
const fileIdentity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`

async function noSymlinks(filename) {
  const parsed = path.parse(filename)
  let current = parsed.root
  for (const part of filename.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink-path')
  }
  if (canonicalPath(await realpath(filename)) !== canonicalPath(filename))
    throw new Error('aliased-path')
}

async function openRegistered(binding) {
  const home = canonicalPath(binding.codexHome)
  const filename = canonicalPath(binding.transcriptPath)
  if (!inside(`${home}/sessions`, filename) && !inside(`${home}/archived_sessions`, filename))
    throw new Error('outside-session-directory')
  await noSymlinks(home)
  await noSymlinks(filename)
  const before = await lstat(filename, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n) throw new Error('unsupported-file')
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat({ bigint: true })
    await noSymlinks(filename)
    const after = await lstat(filename, { bigint: true })
    if (fileIdentity(before) !== fileIdentity(stat) || fileIdentity(stat) !== fileIdentity(after))
      throw new Error('file-changed')
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('unsupported-file-size')
    return { handle, stat, filename }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readBytes(handle, position, length) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

/** Parse one complete rollout record, discarding all message and error text. */
export function parseTranscriptLine(raw) {
  const bytes = Buffer.from(raw)
  if (bytes.length > HOOK_LIMITS.lineBytes) return { kind: 'unknown', reason: 'line-too-large' }
  let data
  try {
    data = JSON.parse(decoder.decode(bytes))
  } catch {
    return { kind: 'unknown', reason: 'invalid-record' }
  }
  if (!isObject(data) || typeof data.type !== 'string')
    return { kind: 'unknown', reason: 'invalid-record' }
  if (IGNORED_RECORDS.has(data.type)) return { kind: 'ignored' }
  if (!isObject(data.payload)) return { kind: 'unknown', reason: 'invalid-record' }
  const payload = data.payload
  if (data.type === 'session_meta') {
    if (
      !validId(payload.id) ||
      !validId(payload.session_id) ||
      (payload.cli_version != null &&
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(payload.cli_version))
    )
      return { kind: 'unknown', reason: 'unsupported-session-metadata' }
    for (const key of ['forked_from_id', 'parent_thread_id']) {
      if (payload[key] != null && !validId(payload[key]))
        return { kind: 'unknown', reason: 'invalid-session-identity' }
    }
    return {
      kind: 'session',
      threadId: payload.id,
      sessionId: payload.session_id,
      creationVersion: payload.cli_version ?? null,
      forkedFromId: payload.forked_from_id ?? null,
      parentThreadId: payload.parent_thread_id ?? null,
    }
  }
  if (data.type !== 'event_msg' || typeof payload.type !== 'string')
    return { kind: 'unknown', reason: 'unknown-record-type' }
  const type = payload.type
  if (IGNORED_EVENTS.has(type)) return { kind: 'ignored' }
  const kinds = {
    task_started: 'started',
    turn_started: 'started',
    task_complete: 'completed',
    turn_complete: 'completed',
    turn_aborted: 'aborted',
  }
  if (!Object.hasOwn(kinds, type)) return { kind: 'unknown', reason: 'unknown-lifecycle-event' }
  if (!validId(payload.turn_id) || (payload.root_turn_id != null && !validId(payload.root_turn_id)))
    return { kind: 'unknown', reason: 'missing-turn-identity' }
  if (type === 'turn_aborted' && !ABORT_REASONS.has(payload.reason))
    return { kind: 'unknown', reason: 'unknown-abort-reason' }
  let kind = kinds[type]
  if (kind === 'completed' && payload.error != null) kind = 'failed'
  return {
    kind,
    turnId: payload.turn_id,
    rootTurnId: payload.root_turn_id ?? null,
    ...(kind === 'aborted' ? { reason: payload.reason } : {}),
  }
}

async function readHeader(handle) {
  const bytes = await readBytes(handle, 0, HOOK_LIMITS.headerBytes + 1)
  const end = bytes.indexOf(10)
  if (end < 0)
    throw new Error(
      bytes.length > HOOK_LIMITS.headerBytes ? 'header-too-large' : 'incomplete-header',
    )
  if (end > HOOK_LIMITS.headerBytes) throw new Error('header-too-large')
  const metadata = parseTranscriptLine(bytes.subarray(0, end))
  if (metadata.kind !== 'session') throw new Error(metadata.reason ?? 'missing-session-header')
  return { metadata, hash: hash(bytes.subarray(0, end + 1)), length: end + 1 }
}

function verifyHeader(binding, metadata) {
  if (metadata.threadId !== binding.threadId || metadata.sessionId !== binding.sessionId)
    throw new Error('thread-mismatch')
  if (binding.agentId) {
    if (
      binding.agentId !== metadata.threadId ||
      metadata.sessionId === metadata.threadId ||
      !metadata.parentThreadId
    )
      throw new Error('agent-mismatch')
  } else if (metadata.threadId !== metadata.sessionId || metadata.parentThreadId)
    throw new Error('root-thread-mismatch')
}

/** Bind a hook only after its target was found in the caller's per-thread registry. */
export async function bindHookTranscript(observation, registration) {
  try {
    if (!supportsBackendVersion(registration.backendVersion))
      return invalid('unsupported-backend-version')
    if (
      !validId(registration.threadId) ||
      canonicalPath(observation.cwd) !== canonicalPath(registration.cwd)
    )
      return invalid('unregistered-thread')
    const exactId = observation.agentId ?? observation.sessionId
    if (exactId !== registration.threadId) return invalid('unregistered-thread')
    const transcriptPath =
      observation.event === 'SubagentStop'
        ? observation.agentTranscriptPath
        : observation.transcriptPath
    if (!transcriptPath) return invalid('missing-transcript-path')
    const binding = {
      codexHome: canonicalPath(registration.codexHome),
      transcriptPath: canonicalPath(transcriptPath),
      threadId: registration.threadId,
      sessionId: observation.sessionId,
      agentId: observation.agentId,
      turnId: observation.turnId,
      backendVersion: registration.backendVersion,
    }
    const { handle } = await openRegistered(binding)
    try {
      verifyHeader(binding, (await readHeader(handle)).metadata)
    } finally {
      await handle.close()
    }
    return { ok: true, binding }
  } catch (error) {
    return invalid(safeReason(error))
  }
}

const SAFE_REASONS = new Set([
  'invalid-path',
  'unsupported-path',
  'outside-session-directory',
  'symlink-path',
  'aliased-path',
  'unsupported-file',
  'file-changed',
  'unsupported-file-size',
  'header-too-large',
  'incomplete-header',
  'missing-session-header',
  'unsupported-session-metadata',
  'invalid-session-identity',
  'invalid-record',
  'thread-mismatch',
  'backend-version-mismatch',
  'agent-mismatch',
  'root-thread-mismatch',
])
const safeReason = (error) =>
  SAFE_REASONS.has(error?.message) ? error.message : 'transcript-unavailable'

function validCursor(cursor) {
  const keys = [
    'version',
    'identity',
    'offset',
    'headerHash',
    'anchorHash',
    'pendingLength',
    'pendingHash',
    'activeTurnId',
  ]
  return (
    isObject(cursor) &&
    Object.keys(cursor).length === keys.length &&
    keys.every((key) => Object.hasOwn(cursor, key)) &&
    cursor.version === 1 &&
    /^[0-9]+:[0-9]+:-?[0-9]+$/.test(cursor.identity) &&
    Number.isSafeInteger(cursor.offset) &&
    cursor.offset >= 0 &&
    /^[a-f0-9]{64}$/.test(cursor.headerHash) &&
    /^[a-f0-9]{64}$/.test(cursor.anchorHash) &&
    Number.isSafeInteger(cursor.pendingLength) &&
    cursor.pendingLength >= 0 &&
    cursor.pendingLength <= HOOK_LIMITS.lineBytes &&
    /^[a-f0-9]{64}$/.test(cursor.pendingHash) &&
    (cursor.activeTurnId === null || validId(cursor.activeTurnId))
  )
}

/**
 * Read complete appended lifecycle records for one registered thread, returning no transcript text.
 * Commit events and cursor together. Unknown results commit neither. An initial null-turn
 * read starts after the final newline, without interpreting inherited history. Identity
 * changes require explicit rebinding; recovery must retain the prior turn and cursor.
 */
export async function readTranscriptDelta(binding, cursor = null) {
  const unknown = (reason) => ({
    status: 'unknown',
    reason,
    events: [],
    cursor: cursor === null || validCursor(cursor) ? cursor : null,
    more: false,
  })
  if (!supportsBackendVersion(binding.backendVersion)) return unknown('unsupported-backend-version')
  if (cursor !== null && !validCursor(cursor)) return unknown('invalid-cursor')
  let handle
  try {
    const opened = await openRegistered(binding)
    handle = opened.handle
    const { stat } = opened
    const header = await readHeader(handle)
    verifyHeader(binding, header.metadata)
    const identity = fileIdentity(stat)
    const size = Number(stat.size)
    let offset = cursor?.offset ?? header.length
    if (cursor === null && binding.turnId === null) {
      const tailStart = Math.max(header.length - 1, size - HOOK_LIMITS.lineBytes - 1)
      const tail = await readBytes(handle, tailStart, size - tailStart)
      const lastNewline = tail.lastIndexOf(10)
      if (lastNewline < 0) return unknown('line-too-large')
      offset = tailStart + lastNewline + 1
    }
    if (cursor && (cursor.identity !== identity || cursor.headerHash !== header.hash))
      return unknown('file-replaced')
    if (offset < header.length || offset > size) return unknown('file-truncated')
    const anchorStart = Math.max(0, offset - 4096)
    const anchor = await readBytes(handle, anchorStart, offset - anchorStart)
    if (cursor && hash(anchor) !== cursor.anchorHash) return unknown('committed-bytes-changed')
    if (cursor?.pendingLength) {
      const pending = await readBytes(handle, offset, cursor.pendingLength)
      if (pending.length !== cursor.pendingLength || hash(pending) !== cursor.pendingHash)
        return unknown('partial-bytes-changed')
    }
    const bytes = await readBytes(handle, offset, Math.min(HOOK_LIMITS.readBytes, size - offset))
    const events = []
    let consumed = 0,
      activeTurnId = cursor?.activeTurnId ?? null
    for (;;) {
      const end = bytes.indexOf(10, consumed)
      if (end < 0) break
      if (end - consumed > HOOK_LIMITS.lineBytes) return unknown('line-too-large')
      const event = parseTranscriptLine(bytes.subarray(consumed, end))
      if (event.kind === 'unknown') return unknown(event.reason)
      if (event.kind === 'session') return unknown('unexpected-session-header')
      if (event.kind !== 'ignored') {
        if (event.kind === 'started') {
          if (activeTurnId !== null && activeTurnId !== event.turnId)
            return unknown('overlapping-turn-start')
          activeTurnId = event.turnId
        } else {
          if (activeTurnId !== event.turnId) return unknown('unmatched-turn-terminal')
          activeTurnId = null
        }
        events.push({
          ...event,
          threadId: binding.threadId,
          offset: offset + consumed,
          eventId: `rollout:${hash(identity).slice(0, 16)}:${offset + consumed}`,
        })
      }
      consumed = end + 1
    }
    const pending = bytes.subarray(consumed)
    if (pending.length > HOOK_LIMITS.lineBytes) return unknown('line-too-large')
    const nextOffset = offset + consumed
    const nextAnchor = await readBytes(
      handle,
      Math.max(0, nextOffset - 4096),
      Math.min(nextOffset, 4096),
    )
    const after = await handle.stat({ bigint: true })
    await noSymlinks(opened.filename)
    const pathAfter = await lstat(opened.filename, { bigint: true })
    if (
      fileIdentity(after) !== identity ||
      fileIdentity(pathAfter) !== identity ||
      after.size < stat.size ||
      (after.size === stat.size && after.mtimeNs !== stat.mtimeNs)
    )
      return unknown('file-changed-during-read')
    const newCursor = {
      version: 1,
      identity,
      offset: nextOffset,
      headerHash: header.hash,
      anchorHash: hash(nextAnchor),
      pendingLength: pending.length,
      pendingHash: hash(pending),
      activeTurnId,
    }
    return {
      status: pending.length ? 'partial' : 'ok',
      events,
      cursor: newCursor,
      more: size > offset + bytes.length && consumed > 0,
    }
  } catch (error) {
    return unknown(safeReason(error))
  } finally {
    await handle?.close()
  }
}

function quoted(value, shell) {
  if (!validText(value)) throw new Error('invalid-hook-argument')
  return shell === 'powershell'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\"'\"'")}'`
}

// ProcessStartInfo.Arguments uses Windows native argv quoting, independently of PowerShell.
function nativeArgument(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** Render argv for POSIX or an ASCII Windows entry point usable from Bash, cmd and PowerShell. */
export function hookCommand(argv, shell) {
  if (
    !Array.isArray(argv) ||
    argv.length < 2 ||
    !['git-bash', 'posix', 'powershell'].includes(shell)
  )
    throw new Error('invalid-hook-command')
  argv.forEach((value) => quoted(value, 'posix'))
  if (shell === 'posix') return argv.map((value) => quoted(value, 'posix')).join(' ')
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = ${quoted(argv[0], 'powershell')}
  $info.Arguments = ${quoted(argv.slice(1).map(nativeArgument).join(' '), 'powershell')}
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $child = New-Object System.Diagnostics.Process
  $child.StartInfo = $info
  if (-not $child.Start()) { throw 'hook-start-failed' }
  $output = $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $errors = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  [void][Console]::OpenStandardInput().CopyToAsync($child.StandardInput.BaseStream).GetAwaiter().GetResult()
  $child.StandardInput.Close()
  $child.WaitForExit()
  [void]$output.GetAwaiter().GetResult()
  [void]$errors.GetAwaiter().GetResult()
  if ($child.ExitCode -eq 0) { exit 0 }
} catch {
  [Console]::Error.WriteLine('OPL hook launcher failed.')
}
exit 1
`
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

/** Create synchronous hooks with a fixed Windows launcher; windowsShell is a legacy input. */
export function createOwnedHooks({ nodePath, scriptPath, args, windowsShell = 'powershell' }) {
  if (!Array.isArray(args) || !['git-bash', 'powershell'].includes(windowsShell))
    throw new Error('invalid-hook-options')
  const argv = [nodePath, scriptPath, ...args]
  const handler = {
    type: 'command',
    command: hookCommand(argv, 'posix'),
    commandWindows: hookCommand(argv, 'powershell'),
  }
  return {
    hooks: Object.fromEntries(
      [
        'SessionStart',
        'UserPromptSubmit',
        'Stop',
        'Interrupt',
        'PreModelRequest',
        'PostModelRequest',
        'SessionEnd',
      ].map((event) => [
        event,
        [
          {
            hooks: [
              { ...handler, timeout: event === 'Interrupt' || event === 'SessionEnd' ? 3 : 5 },
            ],
          },
        ],
      ]),
    ),
  }
}

function parseConfig(text) {
  if (text === null) return {}
  if (typeof text !== 'string' || Buffer.byteLength(text) > HOOK_LIMITS.stdinBytes)
    throw new Error('invalid-hooks-config')
  let config
  try {
    config = JSON.parse(text)
  } catch {
    throw new Error('invalid-hooks-config')
  }
  if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks)))
    throw new Error('invalid-hooks-config')
  for (const groups of Object.values(config.hooks ?? {})) {
    if (
      !Array.isArray(groups) ||
      groups.some(
        (group) =>
          !isObject(group) ||
          !Array.isArray(group.hooks) ||
          group.hooks.some((handler) => !isObject(handler)),
      )
    )
      throw new Error('invalid-hooks-config')
  }
  return config
}

const equalJson = (left, right) => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
    )
  if (!isObject(left) || !isObject(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
  )
}

const sameHookCommand = (left, right) =>
  left.type === right.type &&
  (left.command === right.command ||
    (right.commandWindows !== undefined && left.commandWindows === right.commandWindows))

function removeFromConfig(config, owned) {
  let removed = 0
  const next = structuredClone(config)
  for (const [event, groups] of Object.entries(next.hooks ?? {})) {
    const ownedGroups = owned.hooks?.[event] ?? []
    const retained = []
    for (const group of groups) {
      const { hooks, ...metadata } = group
      const matchingGroups = ownedGroups.filter(({ hooks: candidateHooks, ...candidateMetadata }) =>
        equalJson(candidateMetadata, metadata),
      )
      const remaining = hooks.filter(
        (handler) =>
          !matchingGroups.some((candidate) =>
            candidate.hooks.some((ownedHandler) => equalJson(ownedHandler, handler)),
          ),
      )
      removed += hooks.length - remaining.length
      if (remaining.length || remaining.length === hooks.length)
        retained.push({ ...group, hooks: remaining })
    }
    if (retained.length) next.hooks[event] = retained
    else delete next.hooks[event]
  }
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks
  return { config: next, removed }
}

/** Replace exact installed handlers in place; Codex persists enabled state by array indices. */
export function upgradeOwnedHooks(originalText, previousOwned, owned) {
  const config = parseConfig(originalText)
  parseConfig(JSON.stringify(previousOwned))
  parseConfig(JSON.stringify(owned))
  const repair = () => ({ status: 'needs-repair', text: originalText })
  if (!equalJson(Object.keys(previousOwned.hooks).sort(), Object.keys(owned.hooks).sort()))
    return repair()
  const replacements = []
  for (const [event, priorGroups] of Object.entries(previousOwned.hooks)) {
    const desiredGroups = owned.hooks[event]
    if (priorGroups.length !== desiredGroups.length) return repair()
    for (const [index, prior] of priorGroups.entries()) {
      const { hooks: priorHandlers, ...priorMetadata } = prior
      const { hooks: desiredHandlers, ...desiredMetadata } = desiredGroups[index]
      if (
        !equalJson(priorMetadata, desiredMetadata) ||
        priorHandlers.length !== desiredHandlers.length
      )
        return repair()
      for (const [handlerIndex, priorHandler] of priorHandlers.entries()) {
        const matches = []
        let commandCount = 0
        for (const group of config.hooks?.[event] ?? []) {
          const { hooks, ...metadata } = group
          for (const [position, handler] of hooks.entries()) {
            if (sameHookCommand(handler, priorHandler)) commandCount++
            if (
              sameHookCommand(handler, desiredHandlers[handlerIndex]) &&
              !equalJson(handler, priorHandler)
            )
              return repair()
            if (equalJson(metadata, priorMetadata) && equalJson(handler, priorHandler))
              matches.push({ group, position })
          }
        }
        if (matches.length !== 1 || commandCount !== 1) return repair()
        replacements.push({ ...matches[0], handler: desiredHandlers[handlerIndex] })
      }
    }
  }
  for (const { group, position, handler } of replacements)
    group.hooks[position] = structuredClone(handler)
  const unchanged = equalJson(config, parseConfig(originalText))
  const text = unchanged ? originalText : `${JSON.stringify(config, null, 2)}\n`
  return {
    status: unchanged ? 'unchanged' : 'installed',
    text,
    backup: { version: 1, originalText, installedHash: hash(text), owned: structuredClone(owned) },
  }
}

/** Append new groups once, retaining existing handler indices and customized command definitions. */
export function mergeOwnedHooks(originalText, owned) {
  const original = parseConfig(originalText)
  parseConfig(JSON.stringify(owned))
  const related = Object.entries(owned.hooks).some(([event, groups]) =>
    (original.hooks?.[event] ?? []).some((group) =>
      group.hooks.some((handler) =>
        groups.some((candidate) =>
          candidate.hooks.some((desired) => sameHookCommand(handler, desired)),
        ),
      ),
    ),
  )
  if (related) return upgradeOwnedHooks(originalText, owned, owned)
  const config = structuredClone(original)
  config.hooks ??= {}
  for (const [event, groups] of Object.entries(owned.hooks))
    config.hooks[event] = [...(config.hooks[event] ?? []), ...structuredClone(groups)]
  const text = `${JSON.stringify(config, null, 2)}\n`
  return {
    status: 'installed',
    text,
    backup: { version: 1, originalText, installedHash: hash(text), owned: structuredClone(owned) },
  }
}

/** Remove only exact owned groups, preserving foreign or customized handler definitions. */
export function removeOwnedHooks(currentText, owned) {
  parseConfig(JSON.stringify(owned))
  const { config, removed } = removeFromConfig(parseConfig(currentText), owned)
  return { text: removed ? `${JSON.stringify(config, null, 2)}\n` : currentText, removed }
}

/** Restore exact original bytes when untouched, otherwise remove only owned groups. Null means no original file. */
export function restoreHooksBackup(currentText, backup) {
  if (!isObject(backup) || backup.version !== 1 || !/^[a-f0-9]{64}$/.test(backup.installedHash))
    throw new Error('invalid-hooks-backup')
  parseConfig(backup.originalText)
  parseConfig(JSON.stringify(backup.owned))
  if (typeof currentText === 'string' && hash(currentText) === backup.installedHash)
    return { text: backup.originalText, exact: true }
  return { text: removeOwnedHooks(currentText, backup.owned).text, exact: false }
}
