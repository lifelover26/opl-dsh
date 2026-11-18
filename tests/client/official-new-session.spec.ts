import { Context, Service } from '@deepseek-ai/cordis'
import { UiWorkspaceService } from '@deepseek-ai/dsh-client-ui-workspace/src/client/navigation.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { allowProjectlessSessions } from '../../src/execution/client/fresh-session.ts'

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T>(initial: T) => {
    let snapshot = initial
    return {
      getSnapshot: () => snapshot,
      set: (next: T) => {
        snapshot = next
      },
    }
  },
}))

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

async function fixture(workspaceIds: string[] = []) {
  const ctx = new Context()
  let ready = false
  const release = vi.fn()
  const create = vi.fn(async () => 'official-blank')
  const list = {
    getSnapshot: () => ({
      phase: ready ? 'ready' : 'loading',
      items: workspaceIds.map((workspaceId) => ({
        workspaceId,
        path: `C:/projects/${workspaceId}`,
        createdAt: '2026-11-18T00:00:00Z',
        sessionIds: [],
      })),
      archivedSessionIds: [],
    }),
    subscribe: () => () => {},
  }
  const sessions = {
    list: {
      getSnapshot: () => ({ phase: ready ? 'ready' : 'loading', ids: [], byId: {} }),
      subscribe: () => () => {},
    },
    retain: (sessionId: string) => ({ sessionId, release }),
    subagentAddress: () => undefined,
    create,
  }
  let workspace!: UiWorkspaceService
  const plugin = await ctx.plugin({
    apply(owner: Context) {
      new (class extends Service {
        beginNavigation = () => new AbortController().signal
        selectPanel = vi.fn()
        constructor() {
          super(owner, 'layout')
        }
      })()
      // Controller fixtures expose only the navigation methods exercised here.
      workspace = new UiWorkspaceService(
        owner,
        {} as ConstructorParameters<typeof UiWorkspaceService>[1],
        { list } as unknown as ConstructorParameters<typeof UiWorkspaceService>[2],
        sessions as unknown as ConstructorParameters<typeof UiWorkspaceService>[3],
        { pinSessionOrder: vi.fn() },
        vi.fn(),
      )
    },
  })
  disposers.push(() => plugin.dispose())
  ready = true
  const projectless = vi.fn(
    async () => 'projectless' as Awaited<ReturnType<typeof workspace.connectWorkspace>>,
  )
  const restore = allowProjectlessSessions(workspace, projectless)
  disposers.push(async () => restore())
  return { workspace, create, projectless, release }
}

it('official global new clears an ungrouped current conversation when no Workspace exists', async () => {
  const f = await fixture()
  f.workspace.openSession('old-projectless' as Parameters<typeof f.workspace.openSession>[0])
  f.workspace.startSession()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.projectless).not.toHaveBeenCalled()
})

it('official global new follows the recent Workspace from an ungrouped conversation', async () => {
  const f = await fixture(['recent'])
  f.workspace.openSession('old-projectless' as Parameters<typeof f.workspace.openSession>[0])
  f.workspace.startSession()
  await vi.waitFor(() =>
    expect(f.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'recent' }),
  )
  expect(f.projectless).not.toHaveBeenCalled()
})

it('an empty-key Workspace resolved by official global new does not reenter the explicit projectless action', async () => {
  const f = await fixture([''])
  f.workspace.startSession()
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: '' }))
  expect(f.projectless).not.toHaveBeenCalled()
})

it('the explicit empty Workspace choice still creates a projectless conversation', async () => {
  const f = await fixture(['recent'])
  f.workspace.startSession('' as Parameters<typeof f.workspace.startSession>[0])
  await vi.waitFor(() => expect(f.projectless).toHaveBeenCalledOnce())
  expect(f.create).not.toHaveBeenCalled()
})
