/** Test hook metadata and reversible configuration with isolated synthetic files only. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  readFile,
  rm,
  rename,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  bindHookTranscript,
  canonicalPath,
  createOwnedHooks,
  hookCommand,
  HOOK_LIMITS,
  mergeOwnedHooks,
  parseHookInput,
  parseTranscriptLine,
  readHookInput,
  readTranscriptDelta,
  removeOwnedHooks,
  restoreHooksBackup,
} from '../installer/skill/coordinator/hooks.mjs'

const PRIVATE = 'SYNTHETIC-PRIVATE-CONTENT-DO-NOT-RETAIN'
const line = (payload, type = 'event_msg') => `${JSON.stringify({ type, payload })}\n`
const meta = (extra = {}) =>
  line(
    {
      id: 'thread-a',
      session_id: 'thread-a',
      cli_version: '0.167.0',
      base_instructions: PRIVATE,
      ...extra,
    },
    'session_meta',
  )
const started = (turn = 'turn-a') => line({ type: 'task_started', turn_id: turn })
const completed = (turn = 'turn-a', error = null) =>
  line({ type: 'task_complete', turn_id: turn, error, last_agent_message: PRIVATE })
const hook = (extra = {}) => ({
  hook_event_name: 'Stop',
  session_id: 'thread-a',
  turn_id: 'turn-a',
  cwd: 'C:/fixture/project',
  transcript_path: 'C:/fixture/home/sessions/run.jsonl',
  stop_hook_active: false,
  prompt: PRIVATE,
  last_assistant_message: PRIVATE,
  model: PRIVATE,
  token_usage: { arbitrary: PRIVATE },
  ...extra,
})

async function fixture(t, { header = meta(), records = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opl-coordinator-hooks-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const codexHome = join(root, 'codex-home'),
    cwd = join(root, 'project')
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  await mkdir(cwd)
  const transcript = join(codexHome, 'sessions', 'run.jsonl')
  await writeFile(transcript, header + records)
  const registration = { codexHome, cwd, threadId: 'thread-a', backendVersion: '0.167.0' }
  const observation = parseHookInput(
    JSON.stringify(hook({ cwd, transcript_path: transcript })),
  ).observation
  const bound = await bindHookTranscript(observation, registration)
  assert.equal(bound.ok, true, JSON.stringify(bound))
  return { root, codexHome, cwd, transcript, registration, observation, binding: bound.binding }
}

test('hook parser retains only metadata and treats model status as an attempt observation', () => {
  const result = parseHookInput(
    JSON.stringify(
      hook({ hook_event_name: 'PostModelRequest', status: 'failed', error: { message: PRIVATE } }),
    ),
  )
  assert.equal(result.ok, true)
  assert.equal(result.observation.requestStatus, 'failed')
  assert.ok(!JSON.stringify(result).includes(PRIVATE))
  assert.ok(!Object.hasOwn(result.observation, 'terminal'))
  assert.equal(
    parseHookInput(JSON.stringify(hook({ thread_id: 'forged-thread' }))).observation.sessionId,
    'thread-a',
  )
})

test('hook parser rejects invalid status, missing turn, unknown event, invalid identity and oversized input', () => {
  for (const change of [
    { status: 'success', hook_event_name: 'PostModelRequest' },
    { turn_id: null },
    { hook_event_name: 'FutureEvent' },
    { session_id: '../other' },
    { stop_hook_active: 'false' },
    { hook_event_name: 'SessionStart', source: 'future' },
  ]) {
    assert.equal(parseHookInput(JSON.stringify(hook(change))).ok, false)
  }
  assert.equal(parseHookInput(Buffer.alloc(HOOK_LIMITS.stdinBytes + 1)).reason, 'input-too-large')
  assert.equal(parseHookInput('{not JSON').reason, 'invalid-json')
  assert.equal(parseHookInput(Buffer.from([0xff])).reason, 'invalid-json')
})

test('SessionStart permits absent turn and preserves only bounded source metadata', () => {
  const result = parseHookInput(
    JSON.stringify(hook({ hook_event_name: 'SessionStart', turn_id: undefined, source: 'resume' })),
  )
  assert.equal(result.ok, true)
  assert.equal(result.observation.turnId, null)
  assert.equal(result.observation.source, 'resume')
})

test('continuation envelopes retain only routing metadata from UserPromptSubmit', () => {
  const continuation = { projectId: 'project-a', intentId: 'coord-123', authorityEpoch: 7 }
  const prompt = JSON.stringify({
    type: 'opl-project-coordinator',
    ...continuation,
    instruction: PRIVATE,
  })
  const result = parseHookInput(
    JSON.stringify(hook({ hook_event_name: 'UserPromptSubmit', prompt })),
  )
  assert.deepEqual(result.observation.continuation, continuation)
  assert.ok(!JSON.stringify(result).includes(PRIVATE))
  assert.equal(
    Object.hasOwn(parseHookInput(JSON.stringify(hook({ prompt }))).observation, 'continuation'),
    false,
  )
  const stale = parseHookInput(
    JSON.stringify(
      hook({
        hook_event_name: 'UserPromptSubmit',
        prompt: JSON.stringify({
          type: 'opl-project-coordinator',
          ...continuation,
          authorityEpoch: 1,
        }),
      }),
    ),
  )
  assert.equal(
    stale.observation.continuation.authorityEpoch,
    1,
    'the runtime must fence an old epoch against current state',
  )
})

test('ordinary prompts and malformed or oversized continuation envelopes expose no body', () => {
  const envelope = {
    type: 'opl-project-coordinator',
    projectId: 'project-a',
    intentId: 'coord-123',
    authorityEpoch: 1,
  }
  const prompts = [
    PRIVATE,
    '{invalid JSON',
    JSON.stringify({ ...envelope, type: 'other' }),
    JSON.stringify({ ...envelope, authorityEpoch: 0 }),
    JSON.stringify({ ...envelope, authorityEpoch: 1.5 }),
    JSON.stringify({ ...envelope, intentId: '../wrong' }),
    JSON.stringify({ ...envelope, projectId: ' ' }),
    JSON.stringify({ ...envelope, instruction: { private: PRIVATE } }),
    JSON.stringify({ ...envelope, prompt: PRIVATE }),
    JSON.stringify({ ...envelope, instruction: 'x'.repeat(9000) }),
  ]
  for (const prompt of prompts) {
    const result = parseHookInput(
      JSON.stringify(hook({ hook_event_name: 'UserPromptSubmit', prompt })),
    )
    assert.equal(result.ok, true)
    assert.equal(Object.hasOwn(result.observation, 'continuation'), false)
    assert.ok(!JSON.stringify(result).includes(PRIVATE))
  }
})

test('Stop continuation guard and Interrupt are distinct from completed cancellation', () => {
  const continued = parseHookInput(JSON.stringify(hook({ stop_hook_active: true })))
  assert.equal(continued.observation.stopHookActive, true)
  const interrupted = parseHookInput(JSON.stringify(hook({ hook_event_name: 'Interrupt' })))
  assert.equal(interrupted.observation.event, 'Interrupt')
  assert.ok(!Object.hasOwn(interrupted.observation, 'terminal'))
  assert.equal(interrupted.observation.turnId, continued.observation.turnId)
})

test('stdin reader accepts split UTF-8 and destroys oversized streams', async () => {
  const bytes = Buffer.from(JSON.stringify(hook({ prompt: `${PRIVATE}中文` })))
  const result = await readHookInput(Readable.from([...bytes].map((value) => Buffer.from([value]))))
  assert.equal(result.ok, true)
  assert.ok(!JSON.stringify(result).includes(PRIVATE))
  const tooLarge = Readable.from([Buffer.alloc(HOOK_LIMITS.stdinBytes), Buffer.from('x')])
  assert.equal((await readHookInput(tooLarge)).reason, 'input-too-large')
  assert.equal(tooLarge.destroyed, true)
})

test('Windows extended aliases canonicalize identically and unsupported namespaces fail closed', () => {
  assert.equal(
    canonicalPath('\\\\?\\C:\\Users\\Root\\.codex\\sessions\\x.jsonl'),
    canonicalPath('c:/users/root/.codex/sessions/x.jsonl'),
  )
  assert.equal(
    canonicalPath('C:\\home\\sessions\\..\\sessions\\x.jsonl'),
    'c:/home/sessions/x.jsonl',
  )
  for (const value of [
    'relative.jsonl',
    '\\\\server\\share\\x',
    '\\\\?\\UNC\\server\\share\\x',
    '\\\\.\\C:\\x',
    'C:/home/x:stream',
    'C:/home/name./x',
    'C:/home/name /x',
    'C:/home/x\n',
  ])
    assert.throws(() => canonicalPath(value))
})

test('lifecycle parser emits no prompt, assistant text, error details or unknown reasons', () => {
  assert.deepEqual(
    parseTranscriptLine(completed('turn-a', { message: PRIVATE, codex_error_info: PRIVATE })),
    { kind: 'failed', turnId: 'turn-a', rootTurnId: null },
  )
  assert.deepEqual(parseTranscriptLine(completed()), {
    kind: 'completed',
    turnId: 'turn-a',
    rootTurnId: null,
  })
  assert.equal(
    parseTranscriptLine(
      line({ type: 'turn_aborted', turn_id: 'turn-a', reason: 'interrupted', message: PRIVATE }),
    ).reason,
    'interrupted',
  )
  assert.equal(
    parseTranscriptLine(line({ type: 'turn_aborted', turn_id: 'turn-a', reason: PRIVATE })).kind,
    'unknown',
  )
  assert.equal(
    parseTranscriptLine(line({ type: 'task_complete', root_turn_id: 'turn-a' })).reason,
    'missing-turn-identity',
  )
  assert.equal(
    parseTranscriptLine(line({ type: 'turn_failed', turn_id: 'turn-a' })).reason,
    'unknown-lifecycle-event',
  )
  assert.equal(parseTranscriptLine(line({ secret: PRIVATE }, 'response_item')).kind, 'ignored')
  assert.equal(
    parseTranscriptLine(Buffer.alloc(HOOK_LIMITS.lineBytes + 1)).reason,
    'line-too-large',
  )
})

test('compatible old creation version does not override attested current backend version', async (t) => {
  const { binding, observation, registration } = await fixture(t, {
    header: meta({ cli_version: '0.120.0' }),
    records: started() + completed(),
  })
  assert.deepEqual(
    (await readTranscriptDelta(binding)).events.map((event) => event.kind),
    ['started', 'completed'],
  )
  assert.equal(
    (await bindHookTranscript(observation, { ...registration, backendVersion: '0.168.0' })).reason,
    'unsupported-backend-version',
  )
})

test('0.169.0 attestation binds and reads lifecycle records while unknown versions remain unknown', async (t) => {
  const f = await fixture(t, {
    header: meta({ cli_version: '0.169.0' }),
    records:
      line({ type: 'task_started', turn_id: 'turn-a', root_turn_id: 'turn-a', started_at: 1 }) +
      line({ type: 'task_complete', turn_id: 'turn-a', root_turn_id: 'turn-a', completed_at: 2 }) +
      started('turn-b') +
      line({ type: 'turn_aborted', turn_id: 'turn-b', reason: 'interrupted' }),
  })
  const bound = await bindHookTranscript(f.observation, {
    ...f.registration,
    backendVersion: '0.169.0',
  })
  assert.equal(bound.ok, true)
  assert.equal(bound.binding.backendVersion, '0.169.0')
  const delta = await readTranscriptDelta(bound.binding)
  assert.equal(delta.status, 'ok')
  assert.deepEqual(
    delta.events.map((event) => event.kind),
    ['started', 'completed', 'started', 'aborted'],
  )
  assert.equal(delta.events.at(-1).reason, 'interrupted')
  for (const backendVersion of ['0.168.0', '0.170.0', '0.169.0-beta', '0.169.1']) {
    assert.equal(
      (await bindHookTranscript(f.observation, { ...f.registration, backendVersion })).reason,
      'unsupported-backend-version',
    )
    assert.equal(
      (await readTranscriptDelta({ ...bound.binding, backendVersion })).reason,
      'unsupported-backend-version',
    )
  }
})

test('binding rejects unregistered identity, cwd, outside home and sibling session directories', async (t) => {
  const f = await fixture(t)
  assert.equal(
    (await bindHookTranscript(f.observation, { ...f.registration, threadId: 'other' })).reason,
    'unregistered-thread',
  )
  assert.equal(
    (await bindHookTranscript({ ...f.observation, cwd: f.codexHome }, f.registration)).reason,
    'unregistered-thread',
  )
  const outside = join(f.root, 'outside.jsonl')
  await writeFile(outside, meta())
  assert.equal(
    (await bindHookTranscript({ ...f.observation, transcriptPath: outside }, f.registration))
      .reason,
    'outside-session-directory',
  )
  const sibling = join(f.codexHome, 'sessions-foreign', 'run.jsonl')
  assert.equal(
    (await bindHookTranscript({ ...f.observation, transcriptPath: sibling }, f.registration))
      .reason,
    'outside-session-directory',
  )
  assert.equal(
    (await bindHookTranscript({ ...f.observation, transcriptPath: null }, f.registration)).reason,
    'missing-transcript-path',
  )
})

test('header id prevents a shared session or forged hook thread_id from binding a subagent to root', async (t) => {
  const f = await fixture(t)
  await writeFile(f.transcript, meta({ id: 'child-a', parent_thread_id: 'thread-a' }))
  assert.equal((await bindHookTranscript(f.observation, f.registration)).reason, 'thread-mismatch')
  const child = { ...f.observation, agentId: 'child-a' }
  assert.equal((await bindHookTranscript(child, f.registration)).reason, 'unregistered-thread')
  assert.equal(
    (await bindHookTranscript(child, { ...f.registration, threadId: 'child-a' })).ok,
    true,
  )
})

test('SubagentStop uses agent_transcript_path and never the parent transcript', async (t) => {
  const f = await fixture(t)
  const childPath = join(f.codexHome, 'sessions', 'child.jsonl')
  await writeFile(
    childPath,
    meta({ id: 'child-a', parent_thread_id: 'thread-a' }) + started() + completed(),
  )
  const child = {
    ...f.observation,
    event: 'SubagentStop',
    agentId: 'child-a',
    agentTranscriptPath: childPath,
  }
  const childRegistry = { ...f.registration, threadId: 'child-a' }
  assert.equal(
    (await bindHookTranscript({ ...child, agentTranscriptPath: null }, childRegistry)).reason,
    'missing-transcript-path',
  )
  const bound = await bindHookTranscript(child, childRegistry)
  assert.equal(bound.ok, true)
  assert.deepEqual(
    (await readTranscriptDelta(bound.binding)).events.map((event) => event.kind),
    ['started', 'completed'],
  )
})

test('fork registers its own session and never emits inherited terminal facts as the new turn', async (t) => {
  const f = await fixture(t, {
    header: meta({ forked_from_id: 'source-thread' }),
    records: started('old-turn') + completed('old-turn'),
  })
  const baseline = await readTranscriptDelta({ ...f.binding, turnId: null })
  assert.equal(baseline.events.length, 0)
  await appendFile(f.transcript, started() + completed())
  const delta = await readTranscriptDelta(f.binding, baseline.cursor)
  assert.deepEqual(
    delta.events.map((event) => event.turnId),
    ['turn-a', 'turn-a'],
  )
  assert.equal((await readTranscriptDelta({ ...f.binding, turnId: null })).events.length, 0)
  await writeFile(
    f.transcript,
    meta({ id: 'fork-thread', session_id: 'fork-thread', forked_from_id: 'thread-a' }),
  )
  assert.equal((await bindHookTranscript(f.observation, f.registration)).reason, 'thread-mismatch')
})

test('a new turn binding drains the old terminal and pairs the next start in one delta', async (t) => {
  const f = await fixture(t, { records: started('turn-a') })
  const first = await readTranscriptDelta(f.binding)
  assert.equal(first.cursor.activeTurnId, 'turn-a')
  await appendFile(f.transcript, completed('turn-a') + started('turn-b'))
  const nextBinding = { ...f.binding, turnId: 'turn-b' }
  const second = await readTranscriptDelta(nextBinding, first.cursor)
  assert.equal(second.status, 'ok')
  assert.deepEqual(
    second.events.map(({ kind, turnId }) => [kind, turnId]),
    [
      ['completed', 'turn-a'],
      ['started', 'turn-b'],
    ],
  )
  assert.equal(second.cursor.activeTurnId, 'turn-b')
  await appendFile(f.transcript, completed('turn-b'))
  const third = await readTranscriptDelta(nextBinding, second.cursor)
  assert.deepEqual(
    third.events.map(({ kind, turnId }) => [kind, turnId]),
    [['completed', 'turn-b']],
  )
  assert.equal(third.cursor.activeTurnId, null)
})

test('an old-turn watcher emits the new start and retains its terminal across later reads', async (t) => {
  const f = await fixture(t, { records: started('turn-a') + completed('turn-a') })
  const first = await readTranscriptDelta(f.binding)
  await appendFile(f.transcript, started('turn-b'))
  const second = await readTranscriptDelta(f.binding, first.cursor)
  assert.deepEqual(
    second.events.map(({ kind, turnId }) => [kind, turnId]),
    [['started', 'turn-b']],
  )
  assert.equal(second.cursor.activeTurnId, 'turn-b')
  await appendFile(f.transcript, completed('turn-b'))
  const third = await readTranscriptDelta(f.binding, second.cursor)
  assert.deepEqual(
    third.events.map(({ kind, turnId }) => [kind, turnId]),
    [['completed', 'turn-b']],
  )
  assert.equal(third.cursor.activeTurnId, null)
  assert.deepEqual(
    (await readTranscriptDelta({ ...f.binding, turnId: 'turn-b' }, third.cursor)).events,
    [],
  )
})

test('a cold metadata baseline can seed the verified current turn before its start reaches disk', async (t) => {
  const f = await fixture(t, {
    records:
      started('old-turn') +
      line({ type: 'turn_aborted', turn_id: 'old-turn', reason: 'interrupted' }),
  })
  const baseline = await readTranscriptDelta({ ...f.binding, turnId: null })
  assert.deepEqual(baseline.events, [])
  const cursor = { ...baseline.cursor, activeTurnId: f.binding.turnId }
  await appendFile(f.transcript, started() + completed())
  const current = await readTranscriptDelta(f.binding, cursor)
  assert.equal(current.status, 'ok')
  assert.deepEqual(
    current.events.map(({ kind, turnId }) => [kind, turnId]),
    [
      ['started', 'turn-a'],
      ['completed', 'turn-a'],
    ],
  )
  assert.equal(current.cursor.activeTurnId, null)
  await appendFile(f.transcript, started('turn-b'))
  const active = await readTranscriptDelta(f.binding, current.cursor)
  await appendFile(f.transcript, started('turn-c'))
  assert.equal(
    (await readTranscriptDelta(f.binding, active.cursor)).reason,
    'overlapping-turn-start',
  )
})

test('initial SessionStart baseline skips historical record formats and observes only later appends', async (t) => {
  const f = await fixture(t, {
    records: line({ type: 'unknown-historical-tag', secret: PRIVATE }) + completed('old-turn'),
  })
  const baseline = await readTranscriptDelta({ ...f.binding, turnId: null })
  assert.equal(baseline.status, 'ok')
  assert.deepEqual(baseline.events, [])
  assert.equal(baseline.more, false)
  assert.ok(!JSON.stringify(baseline).includes(PRIVATE))
  await appendFile(f.transcript, started() + completed())
  const current = await readTranscriptDelta(f.binding, baseline.cursor)
  assert.deepEqual(
    current.events.map((event) => event.kind),
    ['started', 'completed'],
  )
  await appendFile(f.transcript, line({ type: 'unknown-new-tag' }))
  assert.equal(
    (await readTranscriptDelta(f.binding, current.cursor)).reason,
    'unknown-lifecycle-event',
  )
})

test('failed attempt cannot settle turn; exact lifecycle failure after matching start can', async (t) => {
  const f = await fixture(t, {
    records: started() + line({ type: 'agent_message', message: PRIVATE }),
  })
  const first = await readTranscriptDelta(f.binding)
  assert.deepEqual(
    first.events.map((event) => event.kind),
    ['started'],
  )
  assert.equal(first.cursor.activeTurnId, 'turn-a')
  await appendFile(f.transcript, completed('turn-a', { message: PRIVATE }))
  const second = await readTranscriptDelta(f.binding, first.cursor)
  assert.deepEqual(
    second.events.map((event) => event.kind),
    ['failed'],
  )
  assert.equal(second.cursor.activeTurnId, null)
  assert.ok(!JSON.stringify([first, second]).includes(PRIVATE))
})

test('split UTF-8 partial lines retain only hash and commit once after newline', async (t) => {
  const f = await fixture(t, { records: started() })
  const encoded = Buffer.from(
    line({ type: 'agent_message', message: `${PRIVATE}中文` }) + completed(),
  )
  const split = encoded.indexOf(Buffer.from('中')) + 1
  await appendFile(f.transcript, encoded.subarray(0, split))
  const first = await readTranscriptDelta(f.binding)
  assert.equal(first.status, 'partial')
  assert.equal(first.events.length, 1)
  assert.ok(!JSON.stringify(first.cursor).includes(PRIVATE))
  const repeated = await readTranscriptDelta(f.binding, first.cursor)
  assert.equal(repeated.events.length, 0)
  await appendFile(f.transcript, encoded.subarray(split))
  const completedRead = await readTranscriptDelta(f.binding, repeated.cursor)
  assert.deepEqual(
    completedRead.events.map((event) => event.kind),
    ['completed'],
  )
  const unchanged = await readTranscriptDelta(f.binding, completedRead.cursor)
  assert.equal(unchanged.events.length, 0)
  assert.deepEqual(unchanged.cursor, completedRead.cursor)
})

test('unterminated final record never becomes completion and partial rewrites fail closed', async (t) => {
  const f = await fixture(t, { records: started() + completed().trimEnd() })
  const first = await readTranscriptDelta(f.binding)
  assert.deepEqual(
    first.events.map((event) => event.kind),
    ['started'],
  )
  await writeFile(f.transcript, meta() + started() + completed('other').trimEnd())
  const second = await readTranscriptDelta(f.binding, first.cursor)
  assert.equal(second.status, 'unknown')
  assert.equal(second.reason, 'partial-bytes-changed')
  assert.equal(second.events.length, 0)
})

test('replacement, truncation and changed committed bytes invalidate cursor', async (t) => {
  const f = await fixture(t, { records: started() })
  const first = await readTranscriptDelta(f.binding)
  await rename(f.transcript, `${f.transcript}.old`)
  await writeFile(f.transcript, meta() + started() + completed())
  assert.equal((await readTranscriptDelta(f.binding, first.cursor)).reason, 'file-replaced')
  const next = await readTranscriptDelta(f.binding)
  await writeFile(f.transcript, meta())
  assert.equal((await readTranscriptDelta(f.binding, next.cursor)).reason, 'file-truncated')
  await writeFile(f.transcript, meta() + started())
  const last = await readTranscriptDelta(f.binding)
  const bytes = await readFile(f.transcript, 'utf8')
  await writeFile(f.transcript, bytes.replace('task_started', 'task_starteD'))
  assert.equal(
    (await readTranscriptDelta(f.binding, last.cursor)).reason,
    'committed-bytes-changed',
  )
})

test('unknown records, unmatched terminals and oversized lines return no partial batch of events', async (t) => {
  const f = await fixture(t)
  for (const [records, reason] of [
    [completed(), 'unmatched-turn-terminal'],
    [
      started() + line({ type: 'future_lifecycle', turn_id: 'turn-a', secret: PRIVATE }),
      'unknown-lifecycle-event',
    ],
    [started() + '{bad JSON}\n', 'invalid-record'],
    [
      started() + line({ type: 'turn_aborted', turn_id: null, reason: 'interrupted' }),
      'missing-turn-identity',
    ],
    [started() + 'x'.repeat(HOOK_LIMITS.lineBytes + 1), 'line-too-large'],
  ]) {
    await writeFile(f.transcript, meta() + records)
    const result = await readTranscriptDelta(f.binding)
    assert.equal(result.status, 'unknown')
    assert.equal(result.reason, reason)
    assert.deepEqual(result.events, [])
    assert.ok(!JSON.stringify(result).includes(PRIVATE))
  }
})

test('cursor corruption cannot copy unapproved fields into diagnostic output', async (t) => {
  const f = await fixture(t, { records: started() })
  const first = await readTranscriptDelta(f.binding)
  const result = await readTranscriptDelta(f.binding, { ...first.cursor, arbitrary: PRIVATE })
  assert.equal(result.reason, 'invalid-cursor')
  assert.equal(result.cursor, null)
  assert.ok(!JSON.stringify(result).includes(PRIVATE))
  assert.equal(
    (await readTranscriptDelta(f.binding, { ...first.cursor, offset: -1 })).reason,
    'invalid-cursor',
  )
})

test('multi-batch reads make bounded progress and stable event ids survive re-reading', async (t) => {
  const padding = line({ message: 'x'.repeat(512 * 1024) }, 'response_item')
  const f = await fixture(t, { records: started() + padding.repeat(10) + completed() })
  const first = await readTranscriptDelta(f.binding)
  assert.equal(first.more, true)
  assert.ok(first.cursor.offset < HOOK_LIMITS.readBytes + meta().length)
  const second = await readTranscriptDelta(f.binding, first.cursor)
  assert.equal(second.more, false)
  assert.deepEqual(
    [...first.events, ...second.events].map((event) => event.kind),
    ['started', 'completed'],
  )
  assert.equal((await readTranscriptDelta(f.binding)).events[0].eventId, first.events[0].eventId)
})

test('symlink directory redirects are rejected even when target is inside CODEX_HOME', async (t) => {
  const f = await fixture(t)
  const target = join(f.codexHome, 'actual')
  await mkdir(target)
  await writeFile(join(target, 'redirect.jsonl'), meta())
  const redirect = join(f.codexHome, 'sessions', 'redirect')
  await symlink(target, redirect, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await bindHookTranscript(
    { ...f.observation, transcriptPath: join(redirect, 'redirect.jsonl') },
    f.registration,
  )
  assert.ok(['symlink-path', 'aliased-path'].includes(result.reason), JSON.stringify(result))
})

const ownedHooks = (shell = 'git-bash') =>
  createOwnedHooks({
    nodePath: 'C:/Program Files/nodejs/node.exe',
    scriptPath: "C:/suite owner's/hooks.mjs",
    args: ['coordinator', 'hook', '--registry', 'C:/project registry/registry.json'],
    windowsShell: shell,
  })

test('commands use POSIX quoting or a fixed encoded Windows launcher without evaluating argv', () => {
  const argv = [
    'C:/Program Files/node.exe',
    "C:/owner's/script.mjs",
    '`echo forbidden`',
    '$(forbidden)',
    '$SECRET',
  ]
  assert.equal(
    hookCommand(argv, 'posix'),
    "'C:/Program Files/node.exe' 'C:/owner'\"'\"'s/script.mjs' '`echo forbidden`' '$(forbidden)' '$SECRET'",
  )
  const command = hookCommand(argv, 'powershell')
  assert.match(
    command,
    /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/,
  )
  assert.equal(hookCommand(argv, 'git-bash'), command)
  assert.ok(
    Buffer.from(command.split(' ').at(-1), 'base64')
      .toString('utf16le')
      .includes("C:/owner''s/script.mjs"),
  )
  assert.throws(() => hookCommand(['node', 'x\nunsafe'], 'git-bash'))
  assert.throws(() => ownedHooks('unknown'))
  assert.equal(
    ownedHooks('powershell').hooks.Stop[0].hooks[0].commandWindows,
    ownedHooks('git-bash').hooks.Stop[0].hooks[0].commandWindows,
  )
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(ownedHooks().hooks).map(([event, groups]) => [
        event,
        groups[0].hooks[0].timeout,
      ]),
    ),
    {
      SessionStart: 5,
      UserPromptSubmit: 5,
      Stop: 5,
      Interrupt: 3,
      PreModelRequest: 5,
      PostModelRequest: 5,
      SessionEnd: 3,
    },
  )
})

test('hook merge is idempotent, preserves custom hooks and backs up exact original bytes', () => {
  const original =
    '{"custom":{"setting":true}, "hooks":{"Stop":[{"matcher":"custom","hooks":[{"type":"command","command":"NEVER-EXECUTE-THIS"}]}]}}\r\n'
  const owned = ownedHooks()
  const first = mergeOwnedHooks(original, owned)
  assert.equal(first.backup.originalText, original)
  assert.equal(JSON.parse(first.text).hooks.Stop[0].hooks[0].command, 'NEVER-EXECUTE-THIS')
  assert.equal(mergeOwnedHooks(first.text, owned).text, first.text)
  assert.deepEqual(restoreHooksBackup(first.text, first.backup), { text: original, exact: true })
  const without = removeOwnedHooks(first.text, owned)
  assert.equal(without.removed, 7)
  assert.deepEqual(JSON.parse(without.text), JSON.parse(original))
})

test('rollback preserves foreign edits, customized owned entries and user metadata', () => {
  const owned = ownedHooks()
  const initial = mergeOwnedHooks(null, owned)
  const modified = JSON.parse(initial.text)
  modified.hooks.Stop[0].hooks[0].timeout = 3
  modified.hooks.Stop.push({ hooks: [{ type: 'command', command: 'foreign-custom' }] })
  modified.custom = 'user-owned'
  const result = restoreHooksBackup(`${JSON.stringify(modified)}\n`, initial.backup)
  assert.equal(result.exact, false)
  const restored = JSON.parse(result.text)
  assert.equal(restored.custom, 'user-owned')
  assert.equal(restored.hooks.Stop.length, 2)
  assert.equal(restored.hooks.Stop[0].hooks[0].timeout, 3)
  assert.equal(restored.hooks.Stop[1].hooks[0].command, 'foreign-custom')
  assert.equal(Object.keys(restored.hooks).length, 1)
  assert.deepEqual(restoreHooksBackup(initial.text, initial.backup), { text: null, exact: true })
})

test('owned handlers can be removed from mixed groups while preserving foreign handlers and custom matchers', () => {
  const owned = ownedHooks()
  const mixed = structuredClone(owned)
  mixed.hooks.Stop[0].hooks.push({ type: 'command', command: 'foreign-mixed' })
  mixed.hooks.Interrupt[0].matcher = 'user-customized'
  const removed = removeOwnedHooks(JSON.stringify(mixed), owned)
  const remaining = JSON.parse(removed.text)
  assert.deepEqual(remaining.hooks.Stop[0].hooks, [{ type: 'command', command: 'foreign-mixed' }])
  assert.equal(remaining.hooks.Interrupt[0].matcher, 'user-customized')
  assert.equal(remaining.hooks.Interrupt[0].hooks.length, 1)
  assert.equal(Object.keys(remaining.hooks).length, 2)
})

test('malformed or oversized hook configs and backups fail before any mutation', () => {
  const owned = ownedHooks()
  for (const text of [
    'invalid',
    '[]',
    '{"hooks":[]}',
    '{"hooks":{"Stop":{}}}',
    '{"hooks":{"Stop":[{"hooks":"command"}]}}',
    ' '.repeat(HOOK_LIMITS.stdinBytes + 1),
  ])
    assert.throws(() => mergeOwnedHooks(text, owned), /invalid-hooks-config/)
  assert.throws(
    () => restoreHooksBackup('{}', { version: 1, installedHash: 'bad' }),
    /invalid-hooks-backup/,
  )
})
