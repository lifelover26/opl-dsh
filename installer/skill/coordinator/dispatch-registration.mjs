/** Bind feedback identities to work in an explicitly registered chief project. */
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { canonicalPath } from './hooks.mjs'
import { checkWorkBinding, ProjectStore } from './state.mjs'

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const projectStore = (codexHome) =>
  new ProjectStore({ root: join(resolve(codexHome), 'opl-dsh-coordinator', 'projects') })

async function dispatchProject(store, { threadId, cwd, projectId }) {
  if (!threadId || threadId === 'manual') throw new Error('coordinator-chief-thread-required')
  const targetCwd = canonicalPath(resolve(cwd))
  const matches = (await store.list()).filter(
    (state) =>
      state.threadId === threadId &&
      canonicalPath(state.cwd) === targetCwd &&
      state.mode !== 'completed',
  )
  if (matches.length !== 1) throw new Error('coordinator-project-not-unique')
  const state = matches[0]
  if (projectId !== undefined && state.projectId !== projectId)
    throw new Error('coordinator-project-target-conflict')
  if (state.mode !== 'active') throw new Error('coordinator-project-paused')
  return state
}

/** Check the registered work before creating a session or registering feedback. */
export async function preflightDispatchTask(input) {
  const state = await dispatchProject(projectStore(input.codexHome), input)
  checkWorkBinding(state, input)
  return { projectId: state.projectId, authorityEpoch: state.authorityEpoch }
}

/**
 * Bind one native or external task to existing authorized work, without creating a project.
 * Omitting workId leaves dispatch unchanged. Paused, conflicting and ambiguous registrations
 * reject the requested binding; no authorization text or work item is inferred from the task.
 * @param {object} input Exact chief thread, cwd, work and public feedback task/operation identity.
 * @returns {Promise<object>} Bound/existing metadata, or skipped when coordination was not requested.
 */
export async function registerDispatchTask({
  codexHome,
  threadId,
  cwd,
  projectId,
  authorityEpoch,
  workId,
  taskId,
  operationId,
  store = projectStore(codexHome),
}) {
  if (workId === undefined) return { status: 'skipped', reason: 'not-requested' }
  return store.transaction('__project-registry__', async () => {
    const state = await dispatchProject(store, { threadId, cwd, projectId })
    const epoch = authorityEpoch ?? state.authorityEpoch
    const item = state.workItems.find((entry) => entry.workId === workId)
    const existing = item?.taskId === taskId && item?.operationId === operationId
    await store.apply(state.projectId, {
      eventId: `dispatch-bind:${digest([epoch, workId, taskId, operationId])}`,
      type: 'work.bound',
      authorityEpoch: epoch,
      threadId,
      cwd: state.cwd,
      workId,
      taskId,
      operationId,
    })
    return { status: existing ? 'existing' : 'bound', projectId: state.projectId, workId }
  })
}
