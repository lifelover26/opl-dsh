/** Keep an empty edit branch out of the official Workspace's reusable-new-session flow. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { StopEditState } from '../contracts/stop-edit.ts'

const PROJECTLESS_SESSION_STORAGE = 'opl.projectless-session-ids'
const projectlessSessionIds = new Set<string>()

try {
  const stored = JSON.parse(globalThis.localStorage?.getItem(PROJECTLESS_SESSION_STORAGE) ?? '[]')
  if (Array.isArray(stored)) {
    for (const id of stored) if (typeof id === 'string') projectlessSessionIds.add(id)
  }
} catch {
  // A blocked or malformed browser store only loses the convenience marker.
}

/** Remember a Session created without a Workspace across a Desktop reload. */
export function markProjectlessSession(sessionId: string): void {
  projectlessSessionIds.add(sessionId)
  try {
    globalThis.localStorage?.setItem(
      PROJECTLESS_SESSION_STORAGE,
      JSON.stringify([...projectlessSessionIds]),
    )
  } catch {
    // The live in-memory marker still covers the creation navigation.
  }
}

/** @returns whether this Session was created through the projectless flow. */
export function isProjectlessSession(sessionId: string): boolean {
  return projectlessSessionIds.has(sessionId)
}

type WorkspaceId = Parameters<UiWorkspace['connectWorkspace']>[0]
type SessionId = Awaited<ReturnType<UiWorkspace['connectWorkspace']>>

/**
 * Guard the public blank-Session resolver without changing direct Session navigation.
 * @param workspace - official Workspace navigation service.
 * @param sessions - official Session creation service.
 * @param read - read the candidate's durable edit source through the OPL Remote.
 * @returns disposer restoring the owned resolver and rejecting pending resolution.
 */
export function protectEditBranchesFromNewSession(
  workspace: Pick<UiWorkspace, 'connectWorkspace'>,
  sessions: Pick<ISessions, 'create'>,
  read: (sessionId: string) => Promise<StopEditState>,
): () => void {
  const original = workspace.connectWorkspace
  const pending = new Map<WorkspaceId, Promise<SessionId>>()
  let disposed = false
  const checkLifetime = () => {
    if (disposed) throw new Error('New Session resolution is no longer available')
  }
  const resolve = async (workspaceId: WorkspaceId): Promise<SessionId> => {
    checkLifetime()
    const candidate = await original.call(workspace, workspaceId)
    checkLifetime()
    const state = await read(candidate)
    checkLifetime()
    if (state.sessionId !== candidate) throw new Error('New Session candidate changed')
    if (state.editSourceSessionId === undefined) return candidate
    // Explicitly omit the candidate identity: create a separate Session and keep its draft intact.
    const fresh = await sessions.create({ workspaceId })
    checkLifetime()
    return fresh
  }
  const guarded = (workspaceId: WorkspaceId): Promise<SessionId> => {
    const existing = pending.get(workspaceId)
    if (existing) return existing
    const attempt = resolve(workspaceId).finally(() => pending.delete(workspaceId))
    pending.set(workspaceId, attempt)
    return attempt
  }
  workspace.connectWorkspace = guarded
  return () => {
    disposed = true
    if (workspace.connectWorkspace === guarded) workspace.connectWorkspace = original
  }
}

/**
 * Provide explicit projectless navigation through the ungrouped Workspace key.
 *
 * Untargeted New Session inherits an explicitly projectless main conversation.
 * The empty key creates and opens an unattached Session through the existing Host owner.
 * @param workspace - official navigation service.
 * @param createProjectless - create and catalogue an unattached ordinary Session.
 * @param currentProjectless - whether the main view holds an explicitly projectless Session.
 * @returns disposer restoring the original start action.
 */
export function allowProjectlessSessions(
  workspace: Pick<UiWorkspace, 'startSession' | 'openSession'>,
  createProjectless: () => Promise<SessionId>,
  currentProjectless: () => boolean = () => false,
): () => void {
  const original = workspace.startSession
  let disposed = false
  const start: UiWorkspace['startSession'] = (workspaceId, options) => {
    const projectless =
      (workspaceId === '' && options?.prompt === undefined && options?.agentPreset === undefined) ||
      (workspaceId === undefined && options === undefined && currentProjectless())
    if (!projectless) {
      original.call(workspace, workspaceId, options)
      return
    }
    void createProjectless()
      .then((sessionId) => {
        if (!disposed) {
          workspace.openSession(sessionId)
        }
      })
      .catch((error) => {
        if (!disposed) console.warn('projectless Session creation failed:', error)
      })
  }
  workspace.startSession = start
  return () => {
    disposed = true
    if (workspace.startSession === start) workspace.startSession = original
  }
}
