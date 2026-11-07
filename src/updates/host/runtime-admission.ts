/** Host-wide task exclusion and clean-exit evidence for the Suite update runner. */
import type { Context } from '@deepseek-ai/cordis'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessService } from '../../execution/host/harness.ts'
import {
  assertSuiteAdmission,
  drainUpdateActivity,
  guardUpdateMethods,
  inspectUpdateActivity,
  installUpdateAdmission,
  UpdateAdmission,
} from './admission.ts'

export interface UpdateHandoffIdentity {
  root: string
  id: string
  nonce: string
}

/** The update service owns its freeze until the process exits or handoff fails. */
export interface UpdateRuntime {
  inspect(): Promise<boolean>
  freeze(): Promise<() => void>
  shutdownTarget(identity: UpdateHandoffIdentity | undefined): void
  drained(participant: 'controller' | 'harness'): void
  failed(): void
  onFailure(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplUpdateRuntime: UpdateRuntime
  }
}

/** Install one gate before exposing OPL task dispatch and the update Remote. */
export function installUpdateRuntime(ctx: Context, harness: HarnessService): UpdateRuntime {
  const resumed =
    process.env.OPL_UPDATE_TRANSACTION_ID && process.env.OPL_UPDATE_TRANSACTION_NONCE
      ? {
          id: process.env.OPL_UPDATE_TRANSACTION_ID,
          nonce: process.env.OPL_UPDATE_TRANSACTION_NONCE,
          launcherPid: Number(process.env.OPL_UPDATE_LAUNCHER_PID),
        }
      : undefined
  const gate = new UpdateAdmission(() =>
    assertSuiteAdmission(
      process.env.OPL_SUITE_ROOT,
      resumed,
      Number(process.env.OPL_LAUNCHER_PID) || undefined,
    ),
  )
  installUpdateAdmission(ctx, gate)
  ctx.effect(() =>
    guardUpdateMethods(
      harness,
      [
        'start',
        'prompt',
        'delegateFrom',
        'messageEditSend',
        'stopEdit',
        'selectCombination',
        'createProjectlessSession',
        'updateHarness',
        'saveExecutionCatalog',
        'saveHarnessProxy',
        'selectMiniMaxCandidate',
        'selectCodexRuntime',
        'minimaxAccountLogin',
        'minimaxAccountLogout',
      ],
      gate,
    ),
  )
  ctx.inject(['taskFeedback'], (child) => {
    child.effect(() =>
      guardUpdateMethods(
        child.taskFeedback,
        ['register', 'registerHarnessOperation', 'resumeFailed'],
        gate,
      ),
    )
  })
  ctx.inject(['settings'], (child) => {
    child.effect(() => guardUpdateMethods(child.settings, ['update', 'mutate'], gate))
  })
  ctx.inject(['oplExecution'], (child) => {
    child.effect(() =>
      guardUpdateMethods(
        child.oplExecution,
        ['saveExecutionLimits', 'saveCooperationSettings', 'selectEffort'],
        gate,
      ),
    )
  })
  let target: UpdateHandoffIdentity | undefined
  const drained = new Set<string>()
  const failureListeners = new Set<() => void>()
  const onExit = (code: number) => {
    if (
      code !== 0 ||
      !target ||
      !gate.inspect().frozen ||
      !drained.has('controller') ||
      !drained.has('harness')
    )
      return
    try {
      writeFileSync(
        join(target.root, 'updates', target.id, 'host-drained.json'),
        JSON.stringify({
          schemaVersion: 1,
          transactionId: target.id,
          nonce: target.nonce,
          hostPid: process.pid,
          clean: true,
        }) + '\n',
        { mode: 0o600, flag: 'wx' },
      )
    } catch {
      /* Missing clean evidence prevents the independent runner from installing. */
    }
  }
  process.on('exit', onExit)
  ctx.effect(() => () => {
    if (!target) process.off('exit', onExit)
  })
  const inspect = async () => {
    const feedback = ctx.get('taskFeedback')
    if (!feedback) return false
    const result = await inspectUpdateActivity(ctx, {
      harness: () => ({ busy: harness.updateBusy() }),
      feedbackTasks: () => feedback.tasks(),
    })
    return result.idle && gate.inspect().pending === 0
  }
  return {
    inspect,
    async freeze() {
      const lease = gate.freeze()
      try {
        if (!(await inspect())) throw Error('仍有任务活动，已推迟更新')
        const drainAbort = new AbortController()
        const drainTimer = setTimeout(() => drainAbort.abort(Error('更新排空超时')), 30_000)
        try {
          await drainUpdateActivity(ctx, drainAbort.signal)
          await harness.drainForUpdate()
        } finally {
          clearTimeout(drainTimer)
        }
        if (!(await inspect())) throw Error('任务状态已变化，已推迟更新')
        return () => {
          target = undefined
          lease.release()
        }
      } catch (error) {
        lease.release()
        throw error
      }
    },
    shutdownTarget(identity) {
      target = identity
      drained.clear()
    },
    drained(participant) {
      drained.add(participant)
    },
    failed() {
      for (const listener of failureListeners) listener()
    },
    onFailure(listener) {
      failureListeners.add(listener)
      return () => {
        failureListeners.delete(listener)
      }
    },
  }
}
