/** Event-driven coordination for explicitly registered Codex projects. */
import { createHash } from 'node:crypto'
import { watch as watchFile } from 'node:fs'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ProjectStore } from './state.mjs'
import {
  bindHookTranscript,
  canonicalPath,
  readTranscriptDelta,
  supportsBackendVersion,
} from './hooks.mjs'
import { captureHookOwner, inspectProcess, waitBackendExit } from './process.mjs'
import { readFeedback, readWakeSettings, sendQueueIntent, runProcess } from './feedback.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a, b) => canonicalPath(a) === canonicalPath(b)
const noAction = (reason) => ({ status: 'idle', reason })
const stableEvent = (state, type, fields) => ({
  eventId: `coordinator:${hash([state.projectId, state.authorityEpoch, type, fields])}`,
  type,
  authorityEpoch: state.authorityEpoch,
  ...fields,
})

function lifecycle(row, state) {
  const fields = { eventId: row.eventId, turnId: row.turnId }
  if (row.kind === 'started') return { ...fields, type: 'runtime.started' }
  if (row.kind === 'completed') return { ...fields, type: 'runtime.stopped', terminal: true }
  if (row.kind === 'failed')
    return { ...fields, type: 'runtime.failed', terminal: true, reason: 'turn_failed' }
  if (row.kind === 'aborted')
    return {
      ...fields,
      type: state.seenEvents.some((event) => event.eventId === `hook-user-stop:${row.turnId}`)
        ? 'runtime.failed'
        : ['interrupted', 'replaced'].includes(row.reason)
          ? 'runtime.user_interrupt'
          : 'runtime.uncertain',
      terminal: true,
      reason: row.reason,
    }
  throw new Error('unsupported-lifecycle-event')
}

/**
 * Uses the existing feedback service as execution truth. Dependencies can be replaced only
 * by isolated tests; persisted project records never name executable JavaScript callbacks.
 */
export class Coordinator {
  constructor({
    root,
    codexHome,
    controlPath,
    queue,
    queueSettings = readWakeSettings,
    feedbackWatchPaths = [],
    owner = captureHookOwner,
    inspect = inspectProcess,
    waitExit = waitBackendExit,
    feedback = readFeedback,
    send = sendQueueIntent,
    runControl = runProcess,
    callerThreadId = process.env.CODEX_THREAD_ID,
  }) {
    this.root = resolve(root)
    this.codexHome = resolve(codexHome)
    this.controlPath = resolve(controlPath)
    this.queue = queue
    this.queueSettings = queueSettings
    this.feedbackWatchPaths = feedbackWatchPaths.map((entry) => resolve(entry))
    this.store = new ProjectStore({ root: join(this.root, 'projects') })
    this.owner = owner
    this.inspect = inspect
    this.waitExit = waitExit
    this.feedback = feedback
    this.send = send
    this.runControl = runControl
    this.callerThreadId = callerThreadId
  }

  /** Register authorized work; competing projects in one chat fail closed at every entry. */
  async init(spec) {
    return this.store.transaction('__project-registry__', async () => {
      const conflicts = (await this.store.list()).filter(
        (state) =>
          state.threadId === spec.threadId &&
          state.projectId !== spec.projectId &&
          state.mode !== 'completed',
      )
      if (conflicts.length) throw new Error('thread-already-registered')
      return this.store.init(spec)
    })
  }

  /** Read project state without starting DSH or sending a notification. */
  async status(projectId) {
    return projectId ? this.store.get(projectId) : this.store.list()
  }

  async event(projectId, type, fields) {
    const state = await this.store.get(projectId)
    return this.store.apply(projectId, stableEvent(state, type, fields))
  }

  /** Persist a user pause and invalidate outstanding continuation authority. */
  async pause(projectId, reason = 'user pause') {
    return this.event(projectId, 'project.pause', { reason })
  }

  /** Explicitly resume authorized work; Hook startup alone never resumes a pause. */
  async resume(projectId, reason = 'user resume') {
    return this.event(projectId, 'project.resume', { reason })
  }

  /** Acknowledge an exact continuation after checking its current authorization. */
  async acknowledge(projectId, intentId, authorityEpoch, turnId, entering = false) {
    const state = await this.store.get(projectId)
    if (state.mode !== 'active' || state.authorityEpoch !== authorityEpoch)
      throw new Error('stale-continuation')
    const intent = state.intents.find((entry) => entry.intentId === intentId)
    if (!intent || intent.authorityEpoch !== authorityEpoch || intent.status === 'cancelled')
      throw new Error('stale-continuation')
    return this.store.apply(
      projectId,
      stableEvent(state, 'intent.received', {
        intentId,
        ...((turnId ?? state.runtime.turnId) ? { turnId: turnId ?? state.runtime.turnId } : {}),
        ...(entering ? { entering: true } : {}),
        evidence: 'registered chief acknowledged continuation',
      }),
    )
  }

  async uniqueProject(threadId, cwd) {
    const candidates = (await this.store.list()).filter(
      (state) => state.threadId === threadId && same(state.cwd, cwd) && state.mode !== 'completed',
    )
    return candidates.length === 1 ? candidates[0] : null
  }

  /** Execute only a fenced review decision or receipt consumption through the existing helper. */
  async reviewAction(projectId, request) {
    if (
      !request ||
      !['review', 'consume'].includes(request.kind) ||
      !['accepted', 'changes_requested', undefined].includes(request.decision) ||
      (request.kind === 'review' && (!request.decision || typeof request.noteFile !== 'string'))
    )
      throw new Error('invalid-review-action')
    const owner = await this.owner()
    if (owner.status !== 'known') throw new Error('review-runtime-unknown')
    const snapshot = await this.syncFeedback(projectId)
    if (snapshot.status !== 'available') throw new Error('review-feedback-unavailable')
    const state = await this.store.get(projectId)
    const review = state.reviews.find((entry) => entry.reviewRunId === request.reviewRunId)
    if (
      !review ||
      owner.runId !== state.runtime.runId ||
      this.callerThreadId !== state.threadId ||
      request.authorityEpoch !== state.authorityEpoch ||
      state.mode !== 'active' ||
      request.claimEpoch !== review.claimEpoch ||
      request.consumerId !== review.consumerId
    )
      throw new Error('review-runtime-changed')
    if (
      request.kind === 'consume' &&
      snapshot.consumed.some((row) => row.deliveryId === review.deliveryId)
    )
      return { status: 'accepted', alreadyConsumed: true }
    const task = snapshot.observations.find(
      (row) => row.taskId === review.taskId && row.operationId === review.operationId,
    )
    if (!task) throw new Error('review-task-unavailable')
    let args
    if (request.kind === 'consume') {
      args = [
        'consume',
        review.taskId,
        review.deliveryId,
        '--consumer',
        request.consumerId,
        '--epoch',
        String(request.claimEpoch),
      ]
    } else {
      if (!task.harnessSessionId) throw new Error('review-external-session-required')
      const noteRelative = relative(state.cwd, resolve(request.noteFile))
      if (
        !isAbsolute(request.noteFile) ||
        isAbsolute(noteRelative) ||
        noteRelative === '..' ||
        noteRelative.startsWith('..' + sep)
      )
        throw new Error('review-note-outside-project')
      const [workspacePath, notePath] = await Promise.all([
        realpath(state.cwd),
        realpath(request.noteFile),
      ])
      const realRelative = relative(workspacePath, notePath)
      if (
        isAbsolute(realRelative) ||
        realRelative === '..' ||
        realRelative.startsWith('..' + sep) ||
        !(await stat(notePath)).isFile()
      )
        throw new Error('review-note-outside-project')
      args = [
        'delegate-review',
        '--session',
        task.harnessSessionId,
        '--operation',
        review.operationId,
        '--decision',
        request.decision,
        '--note-file',
        notePath,
      ]
    }
    return this.store.reviewAction(
      projectId,
      {
        actionId: `review-effect:${hash([projectId, review.taskId, review.operationId, request.kind])}`,
        reviewRunId: request.reviewRunId,
        consumerId: request.consumerId,
        claimEpoch: request.claimEpoch,
        authorityEpoch: request.authorityEpoch,
        runId: owner.runId,
        turnId: state.runtime.turnId,
        kind: request.kind,
      },
      async () => {
        const result = await this.runControl(process.execPath, [this.controlPath, ...args], {
          timeoutMs: 15000,
        })
        return {
          status: result.outcome === 'exited' && result.code === 0 ? 'accepted' : 'uncertain',
        }
      },
    )
  }

  /**
   * Drain complete metadata records and commit lifecycle plus cursor in one CAS transaction.
   * A stale reader retries from the latest cursor, never republishes a terminal as a start.
   */
  async observe(projectId, binding, extra = []) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.store.get(projectId)
      if (!state.runtime.runId) return { status: 'unknown', reason: 'runtime-unbound' }
      const priorBinding = state.runtime.binding
      if (priorBinding && !same(priorBinding.transcriptPath, binding.transcriptPath))
        return { status: 'unknown', reason: 'transcript-rebind-required' }
      const cold = !state.runtime.cursor
      const delta = await readTranscriptDelta(
        cold ? { ...binding, turnId: null } : binding,
        state.runtime.cursor ?? null,
      )
      if (delta.status === 'unknown') {
        await this.store.apply(
          projectId,
          stableEvent(state, 'runtime.uncertain', {
            runId: state.runtime.runId,
            reason: delta.reason,
          }),
        )
        return delta
      }
      if (cold && binding.turnId !== null) delta.cursor.activeTurnId = binding.turnId
      const observations = [
        ...delta.events.map((row) => lifecycle(row, state)),
        ...(delta.more ? [] : extra),
      ]
      const fields = {
        runId: state.runtime.runId,
        expectedObservationRevision: state.runtime.observationRevision ?? 0,
        observationId: hash([state.runtime.runId, binding, delta.cursor, observations]),
        binding,
        cursor: delta.cursor,
        observations,
      }
      try {
        const current = await this.store.apply(
          projectId,
          stableEvent(state, 'runtime.observed', fields),
        )
        if (delta.more) {
          if (extra.length) return { status: 'unknown', reason: 'transcript-not-drained' }
          // A bounded delta schedules another pass; no synchronous whole-history scan.
          return { status: 'more', state: current }
        }
        return { status: 'observed', state: current }
      } catch (error) {
        if (!['STALE_OBSERVATION', 'STALE_EPOCH'].includes(error.code)) throw error
      }
    }
    return { status: 'unknown', reason: 'observation-contended' }
  }

  async bindOwner(projectId, owner) {
    let state = await this.store.get(projectId)
    if (state.runtime.runId && state.runtime.runId !== owner.runId) {
      const prior = await this.inspect(state.runtime)
      if (prior.status !== 'exited') return noAction('prior-runtime-not-exited')
      state = await this.store.apply(
        projectId,
        stableEvent(state, 'runtime.recovered', {
          runId: owner.runId,
          previousRunId: state.runtime.runId,
          previousExited: true,
          pid: owner.pid,
          processBirth: owner.processBirth,
        }),
      )
    }
    return this.store.apply(
      projectId,
      stableEvent(state, 'runtime.bind', {
        threadId: state.threadId,
        cwd: state.cwd,
        runId: owner.runId,
        pid: owner.pid,
        processBirth: owner.processBirth,
        backendVersion: owner.backendVersion,
      }),
    )
  }

  /** Short Hook entry; never dispatches workers, accepts work, or answers human approvals. */
  async hook(observation) {
    try {
      return await this.handleHook(observation)
    } catch (error) {
      if (!observation.continuation) throw error
      // A failed command is non-blocking in Codex; queued authority requires explicit JSON denial.
      return {
        status: 'paused',
        output: {
          decision: 'block',
          reason: 'This OPL continuation could not confirm current project authority.',
        },
      }
    }
  }

  async handleHook(observation) {
    const threadId = observation.agentId ?? observation.sessionId
    let state = await this.uniqueProject(threadId, observation.cwd)
    if (!state)
      return observation.continuation
        ? {
            status: 'paused',
            output: {
              decision: 'block',
              reason: 'This OPL project continuation has no active registered target.',
            },
          }
        : noAction('unregistered-thread')
    // User intent wins even if process inspection or transcript reading is unavailable.
    if (
      observation.event === 'Interrupt' &&
      !state.seenEvents.some((event) => event.eventId === `hook-user-stop:${observation.turnId}`)
    ) {
      state = await this.store.apply(state.projectId, {
        eventId: `hook-user-stop:${observation.turnId}`,
        type: 'project.pause',
        authorityEpoch: state.authorityEpoch,
        reason: `user interrupt (${observation.turnId})`,
      })
    }
    if (observation.continuation) {
      const request = observation.continuation
      const intent = state.intents.find((entry) => entry.intentId === request.intentId)
      if (
        request.projectId !== state.projectId ||
        state.mode !== 'active' ||
        request.authorityEpoch !== state.authorityEpoch ||
        intent?.authorityEpoch !== state.authorityEpoch ||
        ['cancelled', 'received'].includes(intent.status)
      )
        return {
          status: 'paused',
          output: {
            decision: 'block',
            reason:
              'Stale or paused OPL project continuation; no work is authorized by this message.',
          },
        }
    }
    if (observation.event === 'UserPromptSubmit' && !observation.continuation) {
      state = await this.store.apply(
        state.projectId,
        stableEvent(state, 'runtime.entering', {
          threadId: state.threadId,
          cwd: state.cwd,
          turnId: observation.turnId,
        }),
      )
    }
    if (observation.continuation) {
      const intent = state.intents.find(
        (entry) => entry.intentId === observation.continuation.intentId,
      )
      try {
        await this.acknowledge(
          state.projectId,
          intent.intentId,
          state.authorityEpoch,
          observation.turnId,
          true,
        )
      } catch (error) {
        if (!['STALE_INTENT', 'STALE_EPOCH'].includes(error.code)) throw error
        return {
          status: 'paused',
          output: {
            decision: 'block',
            reason: 'This OPL continuation was already claimed by another turn.',
          },
        }
      }
    }
    // Request failures are attempt-level facts; terminal logs decide recovery.
    if (observation.event === 'PostModelRequest' || observation.event === 'SessionEnd')
      return noAction('await-terminal')
    const owner = await this.owner()
    if (owner.status !== 'known' || !supportsBackendVersion(owner.backendVersion))
      return noAction(owner.reason ?? 'unsupported-runtime')
    const bound = await bindHookTranscript(observation, {
      threadId: state.threadId,
      cwd: state.cwd,
      codexHome: this.codexHome,
      backendVersion: owner.backendVersion,
    })
    if (!bound.ok) return noAction(bound.reason)
    const binding = bound.binding
    // Drain the old file before a resume supplies a new rollout segment.
    if (state.runtime.binding) {
      const previous = await this.observe(state.projectId, state.runtime.binding)
      if (!['observed'].includes(previous.status))
        return noAction(previous.reason ?? previous.status)
    }
    state = await this.bindOwner(state.projectId, owner)
    if (!state.runtime) return state
    if (
      state.runtime.binding &&
      !same(state.runtime.binding.transcriptPath, binding.transcriptPath)
    ) {
      state = await this.store.apply(
        state.projectId,
        stableEvent(state, 'runtime.rebind', {
          runId: state.runtime.runId,
          previousTranscriptPath: state.runtime.binding.transcriptPath,
          newBinding: binding,
          previousExhausted: true,
        }),
      )
    }
    const extra = []
    if (observation.event === 'Stop')
      extra.push({
        eventId: `hook:stop:${owner.runId}:${observation.turnId}:${observation.stopHookActive}`,
        type: 'runtime.stopped',
        turnId: observation.turnId,
        terminal: false,
      })
    else if (['UserPromptSubmit', 'PreModelRequest'].includes(observation.event))
      extra.push({
        eventId: `hook:start:${owner.runId}:${observation.turnId}`,
        type: 'runtime.started',
        turnId: observation.turnId,
      })
    const result = await this.observe(state.projectId, binding, extra)
    if (result.status !== 'observed') return noAction(result.reason ?? result.status)
    state = result.state
    if (
      observation.event === 'PreModelRequest' ||
      (observation.event === 'Stop' && observation.stopHookActive)
    ) {
      const prior = state.intents.find(
        (intent) =>
          intent.via === 'stop' &&
          intent.turnId === observation.turnId &&
          intent.authorityEpoch === state.authorityEpoch &&
          ['reserved', 'accepted'].includes(intent.status),
      )
      if (prior)
        await this.acknowledge(
          state.projectId,
          prior.intentId,
          state.authorityEpoch,
          observation.turnId,
        )
    }
    if (observation.event !== 'Stop') return { status: 'observed', projectId: state.projectId }
    await this.syncFeedback(state.projectId)
    const decision = await this.store.decide(state.projectId, {
      via: 'stop',
      threadId: state.threadId,
      cwd: state.cwd,
      turnId: observation.turnId,
      stopHookActive: observation.stopHookActive,
    })
    if (decision.action !== 'continue') return noAction(decision.reason)
    return {
      status: 'continue',
      output: {
        decision: 'block',
        reason: `OPL project ${state.projectId} has authorized unfinished work. Run the opl-dsh-official coordinator inspect --project ${state.projectId} command; reconcile its checkpoints before acting. Intent ${decision.intent.intentId}, epoch ${decision.intent.authorityEpoch}.`,
      },
    }
  }

  async syncFeedback(projectId) {
    let state = await this.store.get(projectId)
    if (!state.workItems.some((item) => item.taskId)) return { status: 'available' }
    const snapshot = await this.feedback({ controlPath: this.controlPath, project: state })
    if (snapshot.status !== 'available') return snapshot
    for (const row of snapshot.observations) {
      state = await this.store.get(projectId)
      const item = state.workItems.find((work) => work.workId === row.workId)
      if (!item) continue
      const events = snapshot.events
        .filter((entry) => entry.workId === row.workId)
        .flatMap((entry) =>
          entry.type === 'feedback.consumed' &&
          !state.feedback.some((known) => known.deliveryId === entry.deliveryId)
            ? [
                stableEvent(state, 'feedback.pending', {
                  workId: row.workId,
                  taskId: row.taskId,
                  operationId: row.operationId,
                  deliveryId: entry.deliveryId,
                }),
                entry,
              ]
            : [entry],
        )
        .map((input) => {
          const { authorityEpoch: _epoch, ...event } = input
          if (event.evidence && typeof event.evidence === 'object')
            event.evidence = JSON.stringify(event.evidence)
          for (const key of ['claimEpoch', 'consumerId']) if (event[key] === null) delete event[key]
          // Interrupted workers need a chief audit, never an automatic worker retry.
          if (event.type === 'work.update' && ['cancelled', 'disconnected'].includes(row.state))
            event.status = 'review_due'
          return event
        })
      const next = ['queued', 'accepted', 'running'].includes(row.state)
        ? item.status === 'ready'
          ? 'running'
          : null
        : ['completed', 'failed'].includes(row.state) && item.status === 'running'
          ? 'review_due'
          : null
      if (next && item.status !== 'accepted')
        events.push({
          ...stableEvent(state, 'work.update', {
            workId: item.workId,
            status: next,
            evidence: JSON.stringify({
              source: 'taskFeedback',
              state: row.state,
              updatedAt: row.updatedAt,
            }),
          }),
        })
      for (const event of events) delete event.authorityEpoch
      await this.store.apply(
        projectId,
        stableEvent(state, 'work.observed', {
          workId: item.workId,
          taskId: row.taskId,
          operationId: row.operationId,
          observedAt: row.updatedAt,
          state: row.state,
          events,
        }),
      )
    }
    return snapshot
  }

  /** Reconcile actual logs and receipts, then send at most one reserved short wake. */
  async reconcile(projectId) {
    let state = await this.store.get(projectId)
    const matches = await this.uniqueProject(state.threadId, state.cwd)
    if (!matches || matches.projectId !== projectId) return noAction('unregistered-thread')
    if (state.runtime.binding) {
      const observation = await this.observe(projectId, state.runtime.binding)
      if (observation.status !== 'observed')
        return noAction(observation.reason ?? observation.status)
    }
    await this.syncFeedback(projectId)
    state = await this.store.get(projectId)
    if (state.mode !== 'active') return noAction(state.mode)
    if (state.runtime.enteringTurnId) return noAction('runtime_entering')
    if (!state.runtime.runId || !state.runtime.binding) return noAction('runtime-unbound')
    if (state.runtime.terminal !== true) {
      const observed = await this.inspect(state.runtime)
      if (observed.status !== 'exited') return noAction('runtime-not-terminal')
      state = await this.store.apply(
        projectId,
        stableEvent(state, 'runtime.failed', {
          runId: state.runtime.runId,
          terminal: true,
          reason: 'registered_process_exited',
        }),
      )
    }
    const queue = this.queue ?? (await this.queueSettings({ controlPath: this.controlPath })).queue
    if (!queue) return noAction('wake-settings-unavailable')
    if (queue.transport === 'unconnected') return noAction('queue-unconnected')
    const decision = await this.store.decide(projectId, {
      via: 'queue',
      threadId: state.threadId,
      cwd: state.cwd,
    })
    if (decision.action !== 'queue') {
      const pending = decision.state.intents.find(
        (intent) =>
          intent.authorityEpoch === decision.state.authorityEpoch &&
          ['reserved', 'accepted', 'uncertain'].includes(intent.status),
      )
      return pending
        ? {
            status: 'attention',
            reason: 'continuation-not-confirmed',
            intentId: pending.intentId,
            deliveryStatus: pending.status,
          }
        : noAction(decision.reason)
    }
    // The durable reservation precedes every external effect. A pause can invalidate it.
    const latest = await this.store.get(projectId)
    const intent = latest.intents.find((row) => row.intentId === decision.intent.intentId)
    if (
      latest.mode !== 'active' ||
      latest.authorityEpoch !== intent?.authorityEpoch ||
      intent.status !== 'reserved'
    )
      return noAction('stale-continuation')
    const sent = await this.send({ config: queue, intent: { ...intent, projectId } })
    const type = sent.status === 'accepted' ? 'intent.accepted' : 'intent.uncertain'
    try {
      await this.store.apply(
        projectId,
        stableEvent(latest, type, {
          intentId: intent.intentId,
          evidence: `queue transport ${sent.status}`,
        }),
      )
    } catch (error) {
      if (!['STALE_EPOCH', 'STALE_INTENT'].includes(error.code)) throw error
      // A user pause won the race. The old queued message cannot grant fresh authority.
    }
    return { status: sent.status, intentId: intent.intentId }
  }

  /**
   * Watch only registered files and configured feedback metadata paths. One bounded
   * process waiter per backend detects exits; no recurring model or task-state polling.
   */
  async watch({ projectId, signal } = {}) {
    await mkdir(this.root, { recursive: true })
    return this.store.transaction('__watcher__', async () => {
      const watches = new Map(),
        waiters = new Map()
      const controller = new AbortController()
      let timer,
        busy = false,
        dirty = false,
        closed = false,
        finish
      const refresh = async () => {
        const projects = (await this.store.list()).filter(
          (state) => state.mode !== 'completed' && (!projectId || state.projectId === projectId),
        )
        const paths = new Set([join(this.root, 'projects'), ...this.feedbackWatchPaths])
        for (const state of projects) {
          if (state.runtime.binding) paths.add(dirname(state.runtime.binding.transcriptPath))
          const runtime = state.runtime
          if (runtime.runId && runtime.pid && !waiters.has(runtime.runId)) {
            waiters.set(
              runtime.runId,
              this.waitExit({ ...runtime, signal: controller.signal })
                .then((result) => {
                  if (result.status === 'exited') schedule()
                })
                .catch(() => {}),
            )
          }
        }
        for (const [path, watcher] of watches)
          if (!paths.has(path)) {
            watcher.close()
            watches.delete(path)
          }
        for (const path of paths)
          if (!watches.has(path)) {
            try {
              const watcher = watchFile(path, { persistent: true }, schedule)
              watcher.on('error', () => {
                watcher.close()
                watches.delete(path)
              })
              watches.set(path, watcher)
            } catch (error) {
              if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error
              // A missing optional feedback path supplies no execution or liveness evidence.
            }
          }
        return projects
      }
      const run = async () => {
        if (closed) return
        if (busy) {
          dirty = true
          return
        }
        busy = true
        try {
          const projects = await refresh()
          if (!projects.length) {
            closed = true
            finish?.()
            return
          }
          for (const state of projects) await this.reconcile(state.projectId)
        } finally {
          busy = false
          if (dirty) {
            dirty = false
            schedule()
          }
        }
      }
      const schedule = () => {
        if (closed || timer) return
        timer = setTimeout(() => {
          timer = undefined
          run().catch(() => {
            /* Invalid/unavailable state grants no continuation. */
          })
        }, 150)
      }
      try {
        await run()
        await new Promise((done) => {
          finish = done
          const stop = () => {
            closed = true
            done()
          }
          if (signal?.aborted || closed) stop()
          else signal?.addEventListener('abort', stop, { once: true })
        })
      } finally {
        closed = true
        clearTimeout(timer)
        controller.abort()
        for (const watcher of watches.values()) watcher.close()
        await Promise.allSettled(waiters.values())
      }
      return { status: 'stopped' }
    })
  }
}
