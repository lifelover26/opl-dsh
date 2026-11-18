/** Task bindings reuse explicitly registered plans and preserve chief authorization. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectStore } from '../installer/skill/coordinator/state.mjs'
import { registerDispatchTask } from '../installer/skill/coordinator/dispatch-registration.mjs'

async function fixture(t, { registered = true, workItems } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opl-coordinator-dispatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore({ root: join(root, 'projects') })
  const input = {
    codexHome: root,
    threadId: 'thread-1',
    cwd: root,
    workId: 'first',
    taskId: 'task-1',
    operationId: 'operation-1',
    store,
  }
  const plan = {
    projectId: 'explicit-project',
    cwd: root,
    threadId: input.threadId,
    authorization: 'explicit original user authorization',
    workItems:
      workItems ??
      ['first', 'second'].map((workId) => ({ workId, acceptance: 'independent artifact review' })),
  }
  if (registered) await store.init(plan)
  return { store, input, plan }
}

test('ordinary dispatch and absent projects never create continuation authority', async (t) => {
  const { store, input } = await fixture(t, { registered: false })
  assert.deepEqual(await registerDispatchTask({ ...input, workId: undefined }), {
    status: 'skipped',
    reason: 'not-requested',
  })
  await assert.rejects(registerDispatchTask(input), /coordinator-project-not-unique/)
  assert.equal((await store.list()).length, 0)
})

test('parallel tasks bind to one explicit project and retries retain the same task identity', async (t) => {
  const { store, input, plan } = await fixture(t)
  const other = { ...input, workId: 'second', taskId: 'task-2' }
  const bound = await Promise.all([registerDispatchTask(input), registerDispatchTask(other)])
  assert.deepEqual(
    bound.map((row) => row.status),
    ['bound', 'bound'],
  )
  assert.equal((await registerDispatchTask(input)).status, 'existing')
  const state = await store.get(plan.projectId)
  assert.equal(state.authorization, plan.authorization)
  assert.equal(state.workItems.length, 2)
  assert.equal((await store.list()).length, 1)
  assert.deepEqual(
    state.workItems.map((row) => row.taskId),
    ['task-1', 'task-2'],
  )
})

test('changing operation, work, chief or cwd cannot rebind registered work', async (t) => {
  const { store, input, plan } = await fixture(t)
  await registerDispatchTask(input)
  await assert.rejects(registerDispatchTask({ ...input, operationId: 'operation-2' }), {
    code: 'CONFLICT',
  })
  await assert.rejects(registerDispatchTask({ ...input, workId: 'missing' }), { code: 'NOT_FOUND' })
  await assert.rejects(
    registerDispatchTask({ ...input, threadId: 'foreign' }),
    /coordinator-project-not-unique/,
  )
  await assert.rejects(
    registerDispatchTask({ ...input, cwd: join(input.cwd, 'other') }),
    /coordinator-project-not-unique/,
  )
  await assert.rejects(registerDispatchTask({ ...input, workId: 'second' }), { code: 'CONFLICT' })
  assert.equal((await store.get(plan.projectId)).workItems[0].operationId, 'operation-1')
})

test('paused or ambiguous projects reject binding without changing authorization', async (t) => {
  const { store, input, plan } = await fixture(t)
  await store.apply(plan.projectId, {
    eventId: 'pause',
    type: 'project.pause',
    authorityEpoch: 1,
    reason: 'user stopped',
  })
  await assert.rejects(registerDispatchTask(input), /coordinator-project-paused/)
  await store.init({ ...plan, projectId: 'second-project' })
  await assert.rejects(registerDispatchTask(input), /coordinator-project-not-unique/)
  assert.equal((await store.get(plan.projectId)).authorityEpoch, 2)
})

test('unfinished dependencies are not silently waived by a dispatch binding', async (t) => {
  const { input } = await fixture(t, {
    workItems: [
      { workId: 'first', dependsOn: ['second'], acceptance: 'review' },
      { workId: 'second', acceptance: 'dependency' },
    ],
  })
  await assert.rejects(registerDispatchTask(input), { code: 'CONFLICT' })
})
