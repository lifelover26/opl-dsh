/** Project admissions serialize across processes and preserve authorization after crashes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { ProjectStore } from '../installer/skill/coordinator/state.mjs'

const moduleUrl = new URL('../installer/skill/coordinator/state.mjs', import.meta.url).href
const canonical = (value) => JSON.stringify(value)
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex')

async function fixture(
  t,
  workItems = [{ workId: 'build', acceptance: 'artifact and checks pass', dependsOn: [] }],
) {
  const root = await mkdtemp(join(tmpdir(), 'opl-coordinator-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore({ root, now: () => 100 })
  await store.init({
    projectId: 'project',
    cwd: root,
    threadId: 'exact-thread',
    authorization: 'user-request-1',
    workItems,
  })
  let counter = 0
  const event = async (type, fields = {}, authorityEpoch) =>
    store.apply('project', {
      eventId: `event-${++counter}`,
      type,
      authorityEpoch: authorityEpoch ?? (await store.get('project')).authorityEpoch,
      ...fields,
    })
  const bind = async () => {
    await event('runtime.bind', {
      cwd: root,
      threadId: 'exact-thread',
      runId: 'run-1',
      pid: process.pid,
      processBirth: 'fixture-birth',
    })
    await event('runtime.started', { runId: 'run-1', turnId: 'turn-1' })
  }
  const decision = (via = 'stop') =>
    store.decide('project', { via, cwd: root, threadId: 'exact-thread', turnId: 'turn-1' })
  return { root, store, event, bind, decision }
}

function child(source, args = []) {
  const processChild = spawn(process.execPath, ['--input-type=module', '--eval', source, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = ''
  processChild.stdout.on('data', (part) => {
    stdout += part
  })
  processChild.stderr.on('data', (part) => {
    stderr += part
  })
  const completed = new Promise((resolve, reject) => {
    processChild.once('error', reject)
    processChild.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { process: processChild, completed }
}
function observation(root, fields = {}) {
  return {
    runId: 'run-1',
    expectedObservationRevision: 0,
    observationId: 'observation-1',
    binding: {
      codexHome: root,
      transcriptPath: join(root, 'rollout.jsonl'),
      threadId: 'exact-thread',
      sessionId: 'exact-thread',
      agentId: null,
      turnId: 'turn-1',
      backendVersion: '0.167.0',
    },
    cursor: {
      version: 1,
      identity: '1:2:3',
      offset: 100,
      headerHash: 'a'.repeat(64),
      anchorHash: 'b'.repeat(64),
      pendingLength: 0,
      pendingHash: 'c'.repeat(64),
      activeTurnId: null,
    },
    ...fields,
  }
}
async function run(source, args) {
  const result = await child(source, args).completed
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.code, 0, result.stderr)
  return result.stdout ? JSON.parse(result.stdout) : undefined
}

async function reviewFixture(t) {
  const context = await fixture(t)
  await context.bind()
  await context.event('feedback.pending', {
    workId: 'build',
    taskId: 'task',
    deliveryId: 'delivery',
    consumerId: 'owner',
    claimEpoch: 1,
  })
  const request = {
    actionId: 'write-review',
    reviewRunId: 'review-1',
    consumerId: 'owner',
    claimEpoch: 1,
    authorityEpoch: 1,
    runId: 'run-1',
    turnId: 'turn-1',
    kind: 'review',
  }
  await context.event('review.started', {
    ...request,
    deliveryId: 'delivery',
  })
  return { ...context, request }
}

test('target and dependency validation reject unrelated work without publishing state', async (t) => {
  const { root, store, decision } = await fixture(t)
  await assert.rejects(
    store.decide('project', { via: 'queue', cwd: root, threadId: 'another-thread' }),
    { code: 'TARGET_MISMATCH' },
  )
  await assert.rejects(
    store.init({
      projectId: 'cycle',
      cwd: root,
      threadId: 'thread',
      authorization: 'request',
      workItems: [
        { workId: 'a', acceptance: 'pass', dependsOn: ['b'] },
        { workId: 'b', acceptance: 'pass', dependsOn: ['a'] },
      ],
    }),
    { code: 'INVALID' },
  )
  assert.equal((await store.list()).length, 1)
  assert.equal((await decision('queue')).reason, 'runtime_not_idle')
  assert.equal((await store.get('project')).mode, 'active')
})

test('simultaneous processes reserve one intent shared by Stop and queue', async (t) => {
  const { root, store, bind, event } = await fixture(t)
  await bind()
  await event('runtime.stopped', { runId: 'run-1', turnId: 'turn-1' })
  const source = `import {ProjectStore} from ${JSON.stringify(moduleUrl)}; const root=process.argv[1]; const store=new ProjectStore({root}); console.log(JSON.stringify(await store.decide('project',{via:'stop',cwd:root,threadId:'exact-thread',turnId:'turn-1'})));`
  const results = await Promise.all(Array.from({ length: 8 }, () => run(source, [root])))
  assert.equal(results.filter((result) => result.action === 'continue').length, 1)
  assert.equal((await store.get('project')).intents.length, 1)
  await event('runtime.stopped', { runId: 'run-1', turnId: 'turn-1', terminal: true })
  assert.equal(
    (await store.decide('project', { via: 'queue', cwd: root, threadId: 'exact-thread' })).action,
    'none',
  )
})

test('same-owner concurrent stores serialize every update without lost revisions', async (t) => {
  const { root, store } = await fixture(t)
  const source = `import {ProjectStore} from ${JSON.stringify(moduleUrl)}; const root=process.argv[1], lane=process.argv[2]; await Promise.all(Array.from({length:12},(_,i)=>new ProjectStore({root}).apply('project',{eventId:lane+'-'+i,type:'work.update',authorityEpoch:1,workId:'build',status:'ready',evidence:lane+'-'+i})));`
  await Promise.all(Array.from({ length: 4 }, (_, i) => run(source, [root, `lane${i}`])))
  const state = await store.get('project')
  assert.equal(state.revision, 49)
  assert.equal(state.seenEvents.length, 48)
  assert.equal(new Set(state.seenEvents.map((event) => event.eventId)).size, 48)
})

test(
  'Windows unreadable live tickets block until disappearance or the existing lock deadline',
  {
    skip: process.platform !== 'win32' && 'Windows delete-pending files can reject open with EPERM',
  },
  async (t) => {
    const { root, store } = await fixture(t)
    const before = await readFile(store.paths('project').file, 'utf8')
    const source = `
    import fs from 'node:fs/promises';
    import {join} from 'node:path';
    import {randomUUID} from 'node:crypto';
    import {syncBuiltinESMExports} from 'node:module';
    import {ProjectStore} from ${JSON.stringify(moduleUrl)};
    const [root, code, permanent] = process.argv.slice(1);
    const store = new ProjectStore({root});
    const directory = store.paths('project').lock;
    await fs.mkdir(directory, {recursive:true});
    const token = process.pid + '-' + randomUUID();
    const ticket = join(directory, token + '.json');
    await fs.writeFile(ticket, JSON.stringify({pid:process.pid,token,number:0,choosing:false}));
    const original = fs.readFile;
    let reads = 0, entered = false;
    fs.readFile = async function(path, ...args) {
      if (path === ticket) {
        reads++;
        if (permanent === 'yes' || reads === 1) throw Object.assign(new Error('ticket unreadable'), {code});
        await fs.unlink(ticket);
      }
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    if (permanent === 'yes') {
      let ticks = 0;
      Date.now = () => ticks++ * 10001;
    }
    let result;
    try {
      await store.transaction('project', () => { entered = true });
      result = 'entered';
    } catch (error) { result = error.code; }
    await fs.unlink(ticket).catch(error => { if (error.code !== 'ENOENT') throw error });
    console.log(JSON.stringify({result,entered,reads}));
  `
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const recovered = await run(source, [root, code, 'no'])
      assert.deepEqual(recovered, { result: 'entered', entered: true, reads: 2 })
      const blocked = await run(source, [root, code, 'yes'])
      assert.equal(blocked.result, 'LOCK_BUSY')
      assert.equal(blocked.entered, false)
      assert.ok(blocked.reads >= 2)
    }
    assert.equal(await readFile(store.paths('project').file, 'utf8'), before)
    assert.deepEqual(await readdir(store.paths('project').lock), [])
  },
)

test('semantic progress and transport uncertainty never duplicate continuation effects', async (t) => {
  const { store, event, bind, decision } = await fixture(t)
  await bind()
  const first = await decision()
  assert.equal(first.action, 'continue')
  await event('intent.uncertain', { intentId: first.intent.intentId })
  await event('work.update', { workId: 'build', status: 'ready' })
  await event('runtime.stopped', { runId: 'run-1', turnId: 'turn-1' })
  assert.equal((await decision()).action, 'none')
  await event('intent.accepted', {
    intentId: first.intent.intentId,
    evidence: 'bridge accepted original id',
  })
  await event('intent.received', { intentId: first.intent.intentId })
  assert.equal((await decision()).action, 'none')
  const before = (await store.get('project')).progressRevision
  await event('runtime.stopped', { runId: 'run-1', turnId: 'turn-1' })
  assert.equal((await store.get('project')).progressRevision, before)
  await event('work.update', {
    workId: 'build',
    status: 'review_due',
    evidence: 'new artifact revision',
  })
  const second = await decision()
  assert.equal(second.action, 'continue')
  assert.notEqual(first.intent.intentId, second.intent.intentId)
})

test('concurrent receiving turns cannot both claim one intent and same-turn retries are idempotent', async (t) => {
  const { root, store, bind, decision, event } = await fixture(t)
  await bind()
  const first = await decision()
  const source = `import {ProjectStore} from ${JSON.stringify(moduleUrl)};const [root,intentId,turnId]=process.argv.slice(1);const store=new ProjectStore({root});try{await store.apply('project',{eventId:'receive-'+turnId,type:'intent.received',authorityEpoch:1,intentId,turnId});console.log(JSON.stringify({ok:true,turnId}))}catch(error){console.log(JSON.stringify({ok:false,code:error.code,turnId}))}`
  const results = await Promise.all(
    ['receiver-a', 'receiver-b'].map((turnId) =>
      run(source, [root, first.intent.intentId, turnId]),
    ),
  )
  const winner = results.find((result) => result.ok),
    loser = results.find((result) => !result.ok)
  assert.ok(winner)
  assert.equal(loser.code, 'STALE_INTENT')
  const state = await store.get('project')
  assert.equal(state.intents[0].receivedTurnId, winner.turnId)
  await event('intent.received', { intentId: first.intent.intentId, turnId: winner.turnId })
  await assert.rejects(
    event('intent.received', { intentId: first.intent.intentId, turnId: loser.turnId }),
    { code: 'STALE_INTENT' },
  )
  await event('work.update', { workId: 'build', status: 'review_due', evidence: 'next progress' })
  const second = await decision()
  await event('intent.received', { intentId: second.intent.intentId })
  await assert.rejects(
    event('intent.received', { intentId: second.intent.intentId, turnId: 'receiver-c' }),
    { code: 'STALE_INTENT' },
  )
})

test('receipt ingress is atomic and a rejected duplicate cannot overwrite the winning turn', async (t) => {
  const { root, store, bind, decision, event } = await fixture(t)
  await bind()
  const intent = (await decision()).intent
  const source = `import {ProjectStore} from ${JSON.stringify(moduleUrl)};const [root,intentId,turnId]=process.argv.slice(1);try{await new ProjectStore({root}).apply('project',{eventId:'ingress-'+turnId,type:'intent.received',authorityEpoch:1,intentId,turnId,entering:true});console.log(JSON.stringify({ok:true,turnId}))}catch(error){console.log(JSON.stringify({ok:false,turnId,code:error.code}))}`
  const results = await Promise.all(
    ['ingress-a', 'ingress-b'].map((turnId) => run(source, [root, intent.intentId, turnId])),
  )
  const winner = results.find((result) => result.ok),
    loser = results.find((result) => !result.ok)
  assert.ok(winner)
  assert.equal(loser.code, 'STALE_INTENT')
  let state = await store.get('project')
  assert.equal(state.intents[0].receivedTurnId, winner.turnId)
  assert.equal(state.runtime.enteringTurnId, winner.turnId)
  assert.equal(state.runtime.status, 'unknown')
  assert.equal((await decision('queue')).reason, 'runtime_entering')
  await event('runtime.started', { runId: 'run-1', turnId: winner.turnId })
  assert.equal((await store.get('project')).runtime.enteringTurnId, undefined)
  await event('intent.received', {
    intentId: intent.intentId,
    turnId: winner.turnId,
    entering: true,
  })
  state = await store.get('project')
  assert.equal(
    state.runtime.enteringTurnId,
    undefined,
    'same-turn receipt replay does not reopen ingress',
  )
  await assert.rejects(
    event('intent.received', { intentId: intent.intentId, turnId: loser.turnId, entering: true }),
    { code: 'STALE_INTENT' },
  )
  assert.equal((await store.get('project')).runtime.turnId, winner.turnId)
})

test('entering user input survives old terminals, recovery and rebinding until its exact start', async (t) => {
  const { root, store, bind, decision, event } = await fixture(t)
  await bind()
  const input = observation(root)
  await event('runtime.observed', input)
  await event('runtime.stopped', { runId: 'run-1', turnId: 'turn-1', terminal: true })
  const progressBefore = (await store.get('project')).progressRevision
  await assert.rejects(
    event('runtime.entering', { threadId: 'different-thread', cwd: root, turnId: 'turn-b' }),
    { code: 'TARGET_MISMATCH' },
  )
  await event('runtime.entering', { threadId: 'exact-thread', cwd: root, turnId: 'turn-b' })
  await event('runtime.stopped', { runId: 'run-1', turnId: 'turn-1', terminal: true })
  assert.equal((await decision('queue')).reason, 'runtime_entering')
  await event('runtime.started', { runId: 'run-1', turnId: 'turn-1' })
  assert.equal((await store.get('project')).runtime.enteringTurnId, 'turn-b')
  await event('runtime.recovered', {
    previousRunId: 'run-1',
    runId: 'run-2',
    previousExited: true,
    pid: process.pid,
  })
  await event('runtime.rebind', {
    runId: 'run-2',
    previousTranscriptPath: input.binding.transcriptPath,
    newBinding: { ...input.binding, transcriptPath: join(root, 'resumed.jsonl'), turnId: 'turn-b' },
    previousExhausted: true,
  })
  assert.equal((await decision('queue')).reason, 'runtime_entering')
  await event('runtime.started', { runId: 'run-2', turnId: 'turn-a' })
  await event('runtime.stopped', { runId: 'run-2', turnId: 'turn-a', terminal: true })
  assert.equal((await decision('queue')).reason, 'runtime_entering')
  await event('runtime.started', { runId: 'run-2', turnId: 'turn-b' })
  let state = await store.get('project')
  assert.equal(state.runtime.enteringTurnId, undefined)
  assert.equal(state.progressRevision, progressBefore)
  await event('runtime.stopped', { runId: 'run-2', turnId: 'turn-b', terminal: true })
  assert.equal((await decision('queue')).action, 'queue')
})

test('pause races admission, invalidates older events, and explicit resume grants a new epoch', async (t) => {
  const { root, store, bind, event, decision } = await fixture(t)
  await bind()
  const source = `import {ProjectStore} from ${JSON.stringify(moduleUrl)};const root=process.argv[1],store=new ProjectStore({root});console.log(JSON.stringify(await store.apply('project',{eventId:'pause-race',type:'project.pause',authorityEpoch:1,reason:'user requested stop'})));`
  await Promise.all([decision(), run(source, [root])])
  let state = await store.get('project')
  assert.equal(state.mode, 'paused_by_user')
  assert.equal(state.authorityEpoch, 2)
  assert.ok(state.intents.every((intent) => intent.status === 'cancelled'))
  assert.equal((await decision()).action, 'none')
  await assert.rejects(
    event('work.update', { workId: 'build', status: 'accepted', evidence: 'late writer' }, 1),
    { code: 'STALE_EPOCH' },
  )
  await event('project.resume', { reason: 'user explicitly resumed' })
  state = await store.get('project')
  assert.equal(state.authorityEpoch, 3)
  assert.equal((await decision()).action, 'continue')
})

test('one consumer cannot start two live reviews and old claim/run cannot write acceptance', async (t) => {
  const { store, event, bind } = await fixture(t)
  await bind()
  await event('feedback.pending', {
    workId: 'build',
    taskId: 'task#operation',
    deliveryId: 'delivery',
    consumerId: 'owner',
    claimEpoch: 4,
  })
  const owner = { reviewRunId: 'review-1', consumerId: 'owner', claimEpoch: 4 }
  await event('review.started', { ...owner, deliveryId: 'delivery', runId: 'run-1' })
  await assert.rejects(
    event('review.started', {
      ...owner,
      reviewRunId: 'review-2',
      deliveryId: 'delivery',
      runId: 'run-1',
    }),
    { code: 'REVIEW_BUSY' },
  )
  await event('review.checkpoint', {
    ...owner,
    workId: 'build',
    checkpoint: {
      artifactRevision: 'sha256:artifact1',
      checks: [{ id: 'unit', result: 'passed', evidence: 'test report 1' }],
    },
  })
  await event('feedback.pending', {
    workId: 'build',
    taskId: 'task#operation',
    deliveryId: 'delivery',
    consumerId: 'owner',
    claimEpoch: 5,
  })
  await assert.rejects(
    event('feedback.pending', {
      workId: 'build',
      taskId: 'task#operation',
      deliveryId: 'delivery',
      consumerId: 'owner',
      claimEpoch: 4,
    }),
    { code: 'STALE_CLAIM' },
  )
  await assert.rejects(
    event('review.finished', {
      ...owner,
      workId: 'build',
      status: 'accepted',
      evidence: 'stale claim',
    }),
    { code: 'STALE_REVIEW' },
  )
  await event('runtime.recovered', {
    previousRunId: 'run-1',
    runId: 'run-2',
    previousExited: true,
    pid: process.pid,
  })
  await event('runtime.started', { runId: 'run-2', turnId: 'turn-2' })
  await assert.rejects(
    event('review.checkpoint', {
      ...owner,
      workId: 'build',
      checkpoint: { artifactRevision: 'late', checks: [] },
    }),
    { code: 'STALE_REVIEW' },
  )
  assert.equal(
    (await store.get('project')).reviews[0].checkpoint.artifactRevision,
    'sha256:artifact1',
  )
  await event('review.started', {
    reviewRunId: 'review-2',
    consumerId: 'owner',
    claimEpoch: 5,
    deliveryId: 'delivery',
    runId: 'run-2',
  })
  await event('review.finished', {
    reviewRunId: 'review-2',
    consumerId: 'owner',
    claimEpoch: 5,
    workId: 'build',
    status: 'accepted',
    evidence: 'accepted artifact1',
  })
  await assert.rejects(event('project.complete', { evidence: 'all done' }), { code: 'INCOMPLETE' })
  await event('feedback.consumed', { deliveryId: 'delivery' })
  await event('project.complete', { evidence: 'required work accepted; receipt consumed' })
  assert.equal((await store.get('project')).mode, 'completed')
})

test('Stop can continue its own review, while terminal closure fences the old turn', async (t) => {
  const { store, event, bind, decision } = await fixture(t)
  await bind()
  await event('feedback.pending', {
    workId: 'build',
    taskId: 'task',
    deliveryId: 'result',
    claimEpoch: 1,
    consumerId: 'owner',
  })
  const owner = { reviewRunId: 'review', consumerId: 'owner', claimEpoch: 1 }
  await event('review.started', { ...owner, runId: 'run-1', deliveryId: 'result' })
  assert.equal((await decision()).action, 'continue')
  await event('runtime.stopped', { runId: 'run-1', turnId: 'turn-1', terminal: true })
  await event('runtime.started', { runId: 'run-1', turnId: 'turn-2' })
  await assert.rejects(
    event('review.finished', {
      ...owner,
      workId: 'build',
      status: 'accepted',
      evidence: 'old turn',
    }),
    { code: 'STALE_REVIEW' },
  )
  assert.equal((await store.get('project')).reviews[0].status, 'fenced')
})

test('same-consumer processes execute one reserved Host review action', async (t) => {
  const { root, store, request } = await reviewFixture(t)
  const progressBefore = (await store.get('project')).progressRevision
  const log = join(root, 'effects.log')
  const source = `import {appendFile} from 'node:fs/promises';import {ProjectStore} from ${JSON.stringify(moduleUrl)};const store=new ProjectStore({root:process.argv[1]});const result=await store.reviewAction('project',JSON.parse(process.argv[2]),async()=>{await appendFile(process.argv[3],'review\\n');return {status:'accepted',evidence:'Host receipt'};});console.log(JSON.stringify({status:result.status,replayed:result.replayed}));`
  const results = await Promise.all([
    run(source, [root, JSON.stringify(request), log]),
    run(source, [root, JSON.stringify(request), log]),
  ])
  assert.equal(results.filter((result) => !result.replayed).length, 1)
  assert.equal(results.find((result) => !result.replayed).status, 'accepted')
  assert.ok(['reserved', 'accepted'].includes(results.find((result) => result.replayed).status))
  assert.equal(await readFile(log, 'utf8'), 'review\n')
  const state = await store.get('project')
  assert.equal(state.reviews[0].actions.length, 1)
  assert.equal(state.reviews[0].actions[0].status, 'accepted')
  assert.equal(state.reviews[0].actions[0].evidence, 'Host receipt')
  assert.equal(state.progressRevision, progressBefore)
  const replay = await run(source, [root, JSON.stringify(request), log])
  assert.deepEqual(replay, { status: 'accepted', replayed: true })
  assert.equal(await readFile(log, 'utf8'), 'review\n')
  const afterReplay = await store.get('project')
  assert.equal(afterReplay.reviews[0].actions.length, 1)
  assert.equal(afterReplay.reviews[0].actions[0].status, 'accepted')
  assert.equal(afterReplay.progressRevision, progressBefore)
})

test('stale review epoch, runtime, turn and owner reject before external effects', async (t) => {
  const { store, event, request } = await reviewFixture(t)
  let calls = 0
  const effect = async () => {
    calls++
    return { status: 'accepted' }
  }
  for (const [fields, code] of [
    [{ authorityEpoch: 2 }, 'STALE_EPOCH'],
    [{ runId: 'other-run' }, 'STALE_RUN'],
    [{ turnId: 'other-turn' }, 'STALE_RUN'],
    [{ consumerId: 'other-owner' }, 'STALE_REVIEW'],
    [{ claimEpoch: 2 }, 'STALE_REVIEW'],
  ])
    await assert.rejects(store.reviewAction('project', { ...request, ...fields }, effect), { code })
  await event('runtime.started', { runId: 'run-1', turnId: 'turn-2' })
  await assert.rejects(store.reviewAction('project', { ...request, turnId: 'turn-2' }, effect), {
    code: 'STALE_REVIEW',
  })
  assert.equal(calls, 0)
  assert.equal((await store.get('project')).reviews[0].actions, undefined)
})

test('crash after durable review reservation never replays the external write', async (t) => {
  const { root, store, request } = await reviewFixture(t)
  const log = join(root, 'crash-effects.log')
  const source = `import {appendFile} from 'node:fs/promises';import {ProjectStore} from ${JSON.stringify(moduleUrl)};await new ProjectStore({root:process.argv[1]}).reviewAction('project',JSON.parse(process.argv[2]),async()=>{await appendFile(process.argv[3],'external-write\\n');process.exit(23);});`
  const crashed = await child(source, [root, JSON.stringify(request), log]).completed
  assert.equal(crashed.code, 23, crashed.stderr)
  let calls = 0
  const replay = await store.reviewAction('project', request, async () => {
    calls++
    return { status: 'accepted' }
  })
  assert.equal(replay.status, 'reserved')
  assert.equal(replay.replayed, true)
  assert.equal(calls, 0)
  assert.equal(await readFile(log, 'utf8'), 'external-write\n')
  assert.equal((await store.get('project')).reviews[0].actions[0].status, 'reserved')
})

test('uncertain Host results persist without leaking errors or retrying the same id', async (t) => {
  const { store, event, request } = await reviewFixture(t)
  let calls = 0
  const result = await store.reviewAction('project', request, async () => {
    calls++
    throw new Error('private prompt and credentials must not persist')
  })
  assert.equal(result.status, 'uncertain')
  const replay = await store.reviewAction('project', request, async () => {
    calls++
    return { status: 'accepted' }
  })
  assert.equal(replay.status, 'uncertain')
  assert.equal(replay.replayed, true)
  assert.equal(calls, 1)
  assert.ok(!JSON.stringify(await store.get('project')).includes('private prompt'))
  const refused = await store.reviewAction(
    'project',
    { ...request, actionId: 'refused-review' },
    async () => ({ status: 'refused' }),
  )
  assert.equal(refused.status, 'uncertain')
  await event('review.finished', {
    ...request,
    workId: 'build',
    status: 'accepted',
    evidence: 'local review finished',
  })
  await assert.rejects(
    store.reviewAction('project', { ...request, kind: 'consume' }, async () => ({
      status: 'accepted',
    })),
    { code: 'CONFLICT' },
  )
})

test('accepted review can consume in its current run or recover without repeating review', async (t) => {
  const { store, event, request } = await reviewFixture(t)
  let reviews = 0,
    consumes = 0
  await store.reviewAction('project', request, async () => {
    reviews++
    return { status: 'accepted' }
  })
  await event('review.finished', {
    ...request,
    workId: 'build',
    status: 'accepted',
    evidence: 'accepted artifact',
  })
  const firstConsume = await store.reviewAction(
    'project',
    { ...request, kind: 'consume', actionId: 'consume-delivery' },
    async () => {
      consumes++
      return { status: 'accepted' }
    },
  )
  assert.equal(firstConsume.status, 'accepted')
  await event('runtime.recovered', {
    previousRunId: 'run-1',
    runId: 'run-2',
    previousExited: true,
    pid: process.pid,
  })
  await event('runtime.started', { runId: 'run-2', turnId: 'turn-2' })
  const recovery = { ...request, reviewRunId: 'review-2', runId: 'run-2', turnId: 'turn-2' }
  await event('review.started', { ...recovery, deliveryId: 'delivery' })
  const existingReview = await store.reviewAction('project', recovery, async () => {
    reviews++
    return { status: 'accepted' }
  })
  assert.equal(existingReview.replayed, true)
  await event('review.finished', {
    ...recovery,
    workId: 'build',
    status: 'accepted',
    evidence: 'existing accepted artifact',
  })
  const existingConsume = await store.reviewAction(
    'project',
    { ...recovery, kind: 'consume', actionId: 'consume-delivery' },
    async () => {
      consumes++
      return { status: 'accepted' }
    },
  )
  assert.equal(existingConsume.replayed, true)
  assert.equal(reviews, 1)
  assert.equal(consumes, 1)
})

test('pause commits while a reserved Host effect is pending and fences its late result', async (t) => {
  const { root, store, event, request } = await reviewFixture(t)
  let signalEntered, releaseEffect
  const entered = new Promise((resolve) => {
    signalEntered = resolve
  })
  const release = new Promise((resolve) => {
    releaseEffect = resolve
  })
  const action = store.reviewAction('project', request, async () => {
    signalEntered()
    await release
    return { status: 'accepted' }
  })
  await entered
  const pause = new ProjectStore({ root }).apply('project', {
    eventId: 'pause-concurrent-review',
    type: 'project.pause',
    authorityEpoch: 1,
    reason: 'user pause',
  })
  const paused = await pause
  assert.equal(paused.mode, 'paused_by_user')
  assert.equal(paused.reviews[0].actions[0].status, 'reserved')
  releaseEffect()
  assert.equal((await action).status, 'uncertain')
  assert.equal((await store.get('project')).mode, 'paused_by_user')
  await assert.rejects(
    store.reviewAction('project', request, async () => assert.fail('paused review effect ran')),
    { code: 'STALE_EPOCH' },
  )
  await event('project.resume', { reason: 'explicit resume' })
  const epoch = (await store.get('project')).authorityEpoch
  await assert.rejects(
    store.reviewAction(
      'project',
      { ...request, authorityEpoch: epoch, actionId: 'after-pause' },
      async () => assert.fail('fenced review effect ran'),
    ),
    { code: 'STALE_REVIEW' },
  )
})

test('another process pauses a pending Host action and crash recovery keeps its reservation', async (t) => {
  const { root, store, event, request } = await reviewFixture(t)
  const source = `import {ProjectStore} from ${JSON.stringify(moduleUrl)};await new ProjectStore({root:process.argv[1]}).reviewAction('project',JSON.parse(process.argv[2]),async()=>{console.log('started');await new Promise(resolve=>setTimeout(resolve,60000));return {status:'accepted'};});`
  const worker = child(source, [root, JSON.stringify(request)])
  const entered = new Promise((resolve) => worker.process.stdout.once('data', resolve))
  await Promise.race([
    entered,
    worker.completed.then((result) =>
      assert.fail(`Host child exited before reservation: ${result.code}`),
    ),
  ])
  let timer, paused
  try {
    paused = await Promise.race([
      event('project.pause', { reason: 'user pause while Host is pending' }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    worker.process.kill('SIGKILL')
    await worker.completed
  }
  assert.ok(paused, 'pause waited for the other process Host call')
  assert.equal(paused.mode, 'paused_by_user')
  assert.equal(paused.reviews[0].actions[0].status, 'reserved')
  await event('project.resume', { reason: 'explicit user resume' })
  await event('review.started', {
    ...request,
    reviewRunId: 'review-2',
    deliveryId: 'delivery',
    authorityEpoch: 3,
  })
  const recovered = await store.reviewAction(
    'project',
    { ...request, reviewRunId: 'review-2', authorityEpoch: 3 },
    async () => assert.fail('reserved action was replayed'),
  )
  assert.equal(recovered.status, 'reserved')
  assert.equal(recovered.replayed, true)
})

test('recovered accepted work consumes its receipt without another review write', async (t) => {
  const { store, event, request } = await reviewFixture(t)
  await store.reviewAction('project', request, async () => ({ status: 'accepted' }))
  await event('review.finished', {
    ...request,
    workId: 'build',
    status: 'accepted',
    evidence: 'accepted artifact; receipt is still pending',
  })
  await event('runtime.recovered', {
    previousRunId: 'run-1',
    runId: 'run-2',
    previousExited: true,
    pid: process.pid,
  })
  await event('runtime.started', { runId: 'run-2', turnId: 'turn-2' })
  const recovery = {
    ...request,
    reviewRunId: 'review-2',
    runId: 'run-2',
    turnId: 'turn-2',
    kind: 'consume',
    actionId: 'consume-pending-delivery',
  }
  await event('review.started', { ...recovery, deliveryId: 'delivery' })
  await event('review.finished', {
    ...recovery,
    workId: 'build',
    status: 'accepted',
    evidence: 'existing accepted artifact',
  })
  let consumes = 0
  const consumed = await store.reviewAction('project', recovery, async () => {
    consumes++
    return { status: 'accepted' }
  })
  assert.equal(consumed.replayed, false)
  assert.equal(consumes, 1)
  const state = await store.get('project')
  assert.equal(state.workItems[0].status, 'accepted')
  assert.deepEqual(
    state.reviews[1].actions.map((action) => action.kind),
    ['consume'],
  )
  assert.equal(state.feedback[0].status, 'pending')
})

test('dependency admission and the total continuation budget are enforced', async (t) => {
  const { root, store, bind, event, decision } = await fixture(t, [
    { workId: 'build', status: 'waiting_external', acceptance: 'build succeeds', dependsOn: [] },
    { workId: 'release', acceptance: 'release succeeds', dependsOn: ['build'] },
  ])
  await bind()
  assert.equal((await decision()).reason, 'no_actionable_work')
  await event('work.update', { workId: 'build', status: 'accepted', evidence: 'build passed' })
  assert.equal((await decision()).action, 'continue')
  const one = await store.init({
    projectId: 'one',
    cwd: root,
    threadId: 'exact-thread',
    authorization: 'one-intent',
    workItems: [{ workId: 'a', acceptance: 'pass', dependsOn: [] }],
    budgets: { maxIntents: 1 },
  })
  await store.apply('one', {
    eventId: 'bind',
    type: 'runtime.bind',
    authorityEpoch: one.authorityEpoch,
    cwd: root,
    threadId: 'exact-thread',
    runId: 'r',
    pid: process.pid,
  })
  await store.apply('one', {
    eventId: 'start',
    type: 'runtime.started',
    authorityEpoch: 1,
    runId: 'r',
    turnId: 't',
  })
  const input = { via: 'stop', cwd: root, threadId: 'exact-thread', turnId: 't' }
  const first = await store.decide('one', input)
  await store.apply('one', {
    eventId: 'received',
    type: 'intent.received',
    authorityEpoch: 1,
    intentId: first.intent.intentId,
  })
  await store.apply('one', {
    eventId: 'progress',
    type: 'work.update',
    authorityEpoch: 1,
    workId: 'a',
    status: 'review_due',
  })
  assert.equal((await store.decide('one', input)).reason, 'intent_budget')
})

test('waiting for a human and user interruption suppress every automatic wake', async (t) => {
  const { event, bind, decision } = await fixture(t)
  await bind()
  await event('feedback.pending', {
    deliveryId: 'approval',
    taskId: 'task',
    workId: 'build',
    state: 'waiting_approval',
  })
  assert.equal((await decision()).reason, 'waiting_human')
  await event('runtime.user_interrupt', {
    runId: 'run-1',
    turnId: 'turn-1',
    reason: 'user interrupt',
  })
  assert.equal((await decision()).reason, 'paused_by_user')
})

test('a failed model request observation does not establish terminal failure or authorize a queue', async (t) => {
  const { bind, event, decision, store } = await fixture(t)
  await bind()
  await event('runtime.failed', { runId: 'run-1', turnId: 'turn-1', terminal: false })
  assert.equal((await decision('queue')).reason, 'runtime_not_idle')
  await event('runtime.failed', { runId: 'run-1', turnId: 'turn-1', terminal: true })
  assert.equal((await decision('queue')).reason, 'recovery_audit')
  assert.equal((await decision('queue')).action, 'none')
  await assert.rejects(event('project.complete', { evidence: 'no active workers' }), {
    code: 'INCOMPLETE',
  })
  assert.equal((await store.get('project')).mode, 'active')
})

test('event ids are immutable and replaying a pause does not advance authority again', async (t) => {
  const { store } = await fixture(t)
  const pause = { eventId: 'pause', type: 'project.pause', authorityEpoch: 1, reason: 'user pause' }
  await store.apply('project', pause)
  assert.equal((await store.apply('project', pause)).authorityEpoch, 2)
  await assert.rejects(store.apply('project', { ...pause, reason: 'changed payload' }), {
    code: 'CONFLICT',
  })
})

test('a monotonic feedback watermark filters older snapshot effects without granting progress', async (t) => {
  const { store, event } = await fixture(t, [
    {
      workId: 'build',
      taskId: 'task',
      operationId: 'operation',
      acceptance: 'pass',
      dependsOn: [],
      status: 'running',
    },
  ])
  const meta = { workId: 'build', taskId: 'task', operationId: 'operation' }
  const first = await store.get('project')
  await event('work.observed', { ...meta, observedAt: '2026-11-15T10:00:00Z', state: 'running' })
  assert.equal((await store.get('project')).progressRevision, first.progressRevision)
  await event('work.observed', {
    ...meta,
    observedAt: '2026-11-15T11:00:00Z',
    state: 'waiting_input',
    events: [
      {
        eventId: 'waiting-newer',
        type: 'work.update',
        ...meta,
        status: 'waiting_human',
        evidence: 'current DSH human wait',
      },
    ],
  })
  const waiting = await store.get('project')
  await event('work.observed', {
    ...meta,
    observedAt: '2026-11-15T10:30:00Z',
    state: 'completed',
    events: [
      {
        eventId: 'completed-older',
        type: 'work.update',
        ...meta,
        status: 'review_due',
        evidence: 'stale completion',
      },
      {
        eventId: 'delivery-older',
        type: 'feedback.pending',
        ...meta,
        deliveryId: 'old-result',
        state: 'completed',
      },
    ],
  })
  const current = await store.get('project')
  assert.equal(current.workItems[0].status, 'waiting_human')
  assert.equal(current.workItems[0].feedbackObservation.observedAt, '2026-11-15T11:00:00Z')
  assert.equal(current.feedback.length, 0)
  assert.equal(current.progressRevision, waiting.progressRevision)
  await assert.rejects(
    event('work.observed', { ...meta, observedAt: '2026-11-15T11:00:00Z', state: 'completed' }),
    { code: 'CONFLICT' },
  )
  await event('work.observed', {
    ...meta,
    observedAt: '2026-11-15T11:01:00Z',
    state: 'waiting_input',
  })
  assert.equal((await store.get('project')).progressRevision, waiting.progressRevision)
})

test('watermark and receipt projection events commit atomically, with no acceptance from metadata', async (t) => {
  const { store, event } = await fixture(t, [
    {
      workId: 'build',
      taskId: 'task',
      operationId: 'operation',
      acceptance: 'pass',
      dependsOn: [],
      status: 'running',
    },
  ])
  const meta = { workId: 'build', taskId: 'task', operationId: 'operation' }
  const observed = { ...meta, observedAt: '2026-11-15T10:00:00Z', state: 'completed' }
  const pending = {
    eventId: 'delivery-pending',
    type: 'feedback.pending',
    ...meta,
    deliveryId: 'result',
    state: 'completed',
  }
  await event('work.observed', { ...observed, events: [pending] })
  const prior = await store.get('project')
  await assert.rejects(
    event('work.observed', {
      ...observed,
      observedAt: '2026-11-15T10:01:00Z',
      events: [
        {
          eventId: 'bad-update',
          type: 'work.update',
          ...meta,
          status: 'waiting_human',
          evidence: 'should rollback',
        },
        {
          eventId: 'bad-acceptance',
          type: 'work.update',
          ...meta,
          status: 'accepted',
          evidence: 'metadata is insufficient',
        },
      ],
    }),
    { code: 'INVALID' },
  )
  assert.deepEqual(await store.get('project'), prior)
  await event('work.observed', {
    ...observed,
    events: [
      { eventId: 'receipt-consumed', type: 'feedback.consumed', ...meta, deliveryId: 'result' },
    ],
  })
  let state = await store.get('project')
  assert.equal(state.feedback[0].status, 'consumed')
  assert.equal(state.workItems[0].status, 'review_due')
  await event('work.observed', { ...observed, events: [pending] })
  state = await store.get('project')
  assert.equal(state.feedback[0].status, 'consumed')
  await event('work.update', {
    workId: 'build',
    taskId: 'task-next',
    operationId: 'operation-next',
    status: 'running',
  })
  assert.equal((await store.get('project')).workItems[0].feedbackObservation, undefined)
  await assert.rejects(event('work.observed', observed), { code: 'CONFLICT' })
})

test('runtime observation CAS commits lifecycle subevents and a cursor once without business progress', async (t) => {
  const { root, store, event, bind } = await fixture(t)
  await bind()
  const before = await store.get('project')
  const input = observation(root, {
    observations: [
      { eventId: 'rollout:start', type: 'runtime.started', turnId: 'turn-1' },
      { eventId: 'rollout:stop', type: 'runtime.stopped', turnId: 'turn-1', terminal: true },
    ],
  })
  const results = await Promise.allSettled([
    event('runtime.observed', input),
    event('runtime.observed', { ...input, observationId: 'concurrent-reader' }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.code,
    'STALE_OBSERVATION',
  )
  let state = await store.get('project')
  assert.equal(state.runtime.status, 'idle')
  assert.equal(state.runtime.observationRevision, 1)
  assert.deepEqual(state.runtime.binding, input.binding)
  assert.deepEqual(state.runtime.cursor, input.cursor)
  assert.equal(state.progressRevision, before.progressRevision)
  const last = state.runtime.lastObservationId
  await event('runtime.observed', { ...input, observationId: last })
  assert.equal((await store.get('project')).runtime.observationRevision, 1)
  await event(
    'runtime.observed',
    observation(root, {
      observationId: 'replayed-start',
      expectedObservationRevision: 1,
      observations: [input.observations[0]],
    }),
  )
  state = await store.get('project')
  assert.equal(
    state.runtime.status,
    'idle',
    'an already committed start cannot overwrite its terminal',
  )
  assert.equal(state.runtime.observationRevision, 2)
  assert.equal(state.seenEvents.filter((entry) => entry.eventId === 'rollout:start').length, 1)
  await event('runtime.started', { runId: 'run-1', turnId: 'turn-1' })
  await event('runtime.stopped', { runId: 'run-1', turnId: 'turn-1', terminal: false })
  await event('runtime.failed', { runId: 'run-1', turnId: 'turn-1', terminal: false })
  assert.equal(
    (await store.get('project')).runtime.status,
    'idle',
    'late nonterminal hook metadata cannot downgrade a terminal fact',
  )
})

test('invalid observation batches publish neither lifecycle changes nor cursor movement', async (t) => {
  const { root, store, event, bind } = await fixture(t)
  await bind()
  const before = await store.get('project')
  await assert.rejects(
    event(
      'runtime.observed',
      observation(root, {
        observations: [
          { eventId: 'good-start', type: 'runtime.started', turnId: 'turn-1' },
          {
            eventId: 'wrong-stop',
            type: 'runtime.stopped',
            turnId: 'another-turn',
            terminal: true,
          },
        ],
      }),
    ),
    { code: 'STALE_RUN' },
  )
  assert.deepEqual(await store.get('project'), before)
  const extra = observation(root)
  extra.cursor.partial = 'private transcript fragment'
  await assert.rejects(event('runtime.observed', extra), { code: 'INVALID' })
  assert.deepEqual(await store.get('project'), before)
  await event('runtime.observed', observation(root))
  await assert.rejects(
    event(
      'runtime.observed',
      observation(root, {
        expectedObservationRevision: 1,
        observationId: 'backwards',
        cursor: { ...observation(root).cursor, offset: 99 },
      }),
    ),
    { code: 'STALE_OBSERVATION' },
  )
})

test('an interrupt and cursor commit atomically and replay cannot pause again after explicit resume', async (t) => {
  const { root, store, event, bind } = await fixture(t)
  await bind()
  const input = observation(root, {
    observations: [
      {
        eventId: 'rollout:interrupt',
        type: 'runtime.user_interrupt',
        turnId: 'turn-1',
        terminal: true,
      },
    ],
  })
  await event('runtime.observed', input)
  let state = await store.get('project')
  assert.equal(state.mode, 'paused_by_user')
  assert.equal(state.authorityEpoch, 2)
  assert.equal(state.runtime.cursor.offset, 100)
  await event('project.resume', { reason: 'user resumes explicitly' })
  await event('runtime.observed', {
    ...input,
    expectedObservationRevision: 1,
    observationId: 'retry-after-resume',
  })
  state = await store.get('project')
  assert.equal(state.mode, 'active')
  assert.equal(state.authorityEpoch, 3)
  await event('runtime.recovered', {
    previousRunId: 'run-1',
    runId: 'run-2',
    previousExited: true,
    pid: process.pid,
  })
  state = await store.get('project')
  assert.equal(state.runtime.observationRevision, 2)
  assert.equal(state.runtime.lastObservationId, 'retry-after-resume')
  assert.equal(state.runtime.cursor.offset, 100)
  assert.deepEqual(state.runtime.binding, input.binding)
})

test('explicit transcript rebinding fences old observations and requires terminal or recovered ownership', async (t) => {
  const { root, store, event, bind, decision } = await fixture(t)
  await bind()
  const input = observation(root)
  await event('runtime.observed', input)
  const nextBinding = {
    ...input.binding,
    transcriptPath: join(root, 'next-rollout.jsonl'),
    turnId: null,
  }
  const rebind = {
    runId: 'run-1',
    previousTranscriptPath: input.binding.transcriptPath,
    newBinding: nextBinding,
    previousExhausted: true,
  }
  await assert.rejects(event('runtime.rebind', rebind), { code: 'STALE_OBSERVATION' })
  await event('runtime.stopped', { runId: 'run-1', turnId: 'turn-1', terminal: true })
  await assert.rejects(event('runtime.rebind', { ...rebind, previousExhausted: false }), {
    code: 'STALE_OBSERVATION',
  })
  const before = await store.get('project')
  await event('runtime.rebind', rebind)
  let state = await store.get('project')
  assert.equal(state.runtime.observationRevision, before.runtime.observationRevision + 1)
  assert.equal(state.progressRevision, before.progressRevision)
  assert.deepEqual(state.runtime.binding, nextBinding)
  assert.equal(state.runtime.cursor, undefined)
  assert.equal(state.runtime.lastObservationId, undefined)
  assert.equal(state.runtime.status, 'unknown')
  assert.equal((await decision('queue')).action, 'none')
  await assert.rejects(
    event(
      'runtime.observed',
      observation(root, { expectedObservationRevision: 1, observationId: 'stale-reader' }),
    ),
    { code: 'STALE_OBSERVATION' },
  )
  const nextCursor = { ...input.cursor, identity: '4:5:6', offset: 50 }
  await event(
    'runtime.observed',
    observation(root, {
      binding: nextBinding,
      cursor: nextCursor,
      expectedObservationRevision: 2,
      observationId: 'new-file',
    }),
  )
  await event('runtime.recovered', {
    previousRunId: 'run-1',
    runId: 'run-2',
    previousExited: true,
    pid: process.pid,
  })
  await event('runtime.rebind', {
    runId: 'run-2',
    previousTranscriptPath: nextBinding.transcriptPath,
    newBinding: { ...nextBinding, transcriptPath: join(root, 'third-rollout.jsonl') },
    previousExhausted: true,
  })
  state = await store.get('project')
  assert.equal(state.runtime.cursor, undefined)
  assert.equal(state.runtime.binding.transcriptPath, join(root, 'third-rollout.jsonl'))
})

test('dead process tickets and interrupted temporary writes recover without guessing completion', async (t) => {
  const { root, store } = await fixture(t)
  const key = hash('project'),
    lockDir = join(root, 'locks', key)
  await mkdir(lockDir, { recursive: true })
  const source = `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';const root=process.argv[1],key=process.argv[2];const token=process.pid+'-11111111-1111-4111-8111-111111111111';await writeFile(join(root,'locks',key,token+'.json'),'{');await writeFile(join(root,key+'.json.'+process.pid+'.tmp'),'{"partial":');process.exit(23);`
  const result = await child(source, [root, key]).completed
  assert.equal(result.code, 23)
  await store.apply('project', {
    eventId: 'after-crash',
    type: 'work.update',
    authorityEpoch: 1,
    workId: 'build',
    status: 'review_due',
    evidence: 'artifact still pending review',
  })
  const state = await store.get('project')
  assert.equal(state.mode, 'active')
  assert.equal(state.workItems[0].status, 'review_due')
  assert.equal((await readdir(lockDir)).filter((name) => name.endsWith('.json')).length, 0)
  assert.equal(JSON.parse(await readFile(join(root, `${key}.json`), 'utf8')).revision, 2)
})

test('a process killed during a real state write leaves one complete old or new snapshot', async (t) => {
  const { root, store } = await fixture(
    t,
    Array.from({ length: 100 }, (_, i) => ({
      workId: `work-${i}`,
      acceptance: 'a'.repeat(8000),
      dependsOn: [],
    })),
  )
  const key = hash('project')
  let writer,
    observed = false
  const watcher = watch(root, (_event, name) => {
    if (
      name &&
      String(name).startsWith(`${key}.json.`) &&
      String(name).endsWith('.tmp') &&
      writer
    ) {
      observed = true
      writer.kill('SIGKILL')
    }
  })
  t.after(() => watcher.close())
  const source = `import {ProjectStore} from ${JSON.stringify(moduleUrl)};const store=new ProjectStore({root:process.argv[1]});for(let i=0;i<20;i++)await store.apply('project',{eventId:'crash-'+i,type:'work.update',authorityEpoch:1,workId:'work-0',status:'review_due',evidence:'artifact-'+i});`
  const running = child(source, [root])
  writer = running.process
  await running.completed
  watcher.close()
  assert.equal(observed, true, 'writer reached an atomic temporary-file window')
  const state = await store.get('project')
  assert.equal(state.mode, 'active')
  assert.ok(state.revision >= 1 && state.revision <= 21)
  await store.apply('project', {
    eventId: 'recovered',
    type: 'work.update',
    authorityEpoch: 1,
    workId: 'work-1',
    status: 'blocked',
    evidence: 'writer exited; no business completion inferred',
  })
  assert.equal((await store.get('project')).revision, state.revision + 1)
})

test('a live PID with an unverifiable birth identity never loses its lock based on old timestamps', async (t) => {
  const { root, store } = await fixture(t)
  const key = hash('project'),
    lockDir = join(root, 'locks', key)
  const token = `${process.pid}-00000000-0000-4000-8000-000000000000`
  const path = join(lockDir, `${token}.json`)
  await writeFile(
    path,
    JSON.stringify({ pid: process.pid, token, number: 1, choosing: false, createdAt: 0 }),
  )
  t.after(() => rm(path, { force: true }))
  const pending = store.apply('project', {
    eventId: 'blocked',
    type: 'work.update',
    authorityEpoch: 1,
    workId: 'build',
    status: 'review_due',
  })
  await assert.rejects(pending, { code: 'LOCK_BUSY' })
  assert.equal((await store.get('project')).revision, 1)
})
