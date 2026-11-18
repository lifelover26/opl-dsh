import './dom.ts'
import { createTestDom } from './dom.ts'
import { act, createElement, memo, useSyncExternalStore, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  installProjectlessOfficialComposer,
  installProjectlessUngroupedPlus,
  installProjectlessWorkspaceChoice,
} from '../../src/execution/client/ProjectlessOfficialComposer.tsx'
import { markProjectlessSession } from '../../src/execution/client/fresh-session.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ StateDot: () => null }))

const liveProps = {
  useInput: (select: (value: object) => unknown) => select({}),
  keyboard: {},
  inputActions: {},
} as unknown as Pick<ComposerBarProps, 'useInput' | 'keyboard' | 'inputActions'>

function fixture() {
  const core = new SlotCore()
  core.register(
    {
      name: 'root',
      children: {
        'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      },
    },
    () => null,
  )
  const original = memo(() => null)
  const entries = () => core.entries('conversation.composer.bar')
  const install = () =>
    installProjectlessOfficialComposer(
      entries,
      (listener) => core.subscribe('conversation.composer.bar', listener),
      () => '正在恢复会话…',
    )
  const register = () =>
    core.register(
      {
        name: 'conversation.composer.bar',
        children: {
          'conversation.input.right': { kind: 'list', scope: 'session' },
        },
      },
      original,
    )
  return { core, original, entries, install, register }
}

function render(f: ReturnType<typeof fixture>, props: Partial<ComposerBarProps>) {
  const component = f.entries()[0]!.component as (props: ComposerBarProps) => ReactElement
  return component({ ...liveProps, ...props } as ComposerBarProps)
}

describe('official projectless composer adapter', () => {
  it('preserves the official memo component and its existing child declaration', () => {
    const f = fixture()
    f.register()
    const entry = f.entries()[0]!
    const dispose = f.install()
    const id = 'session-projectless-official-test'
    markProjectlessSession(id)
    const element = render(f, {
      sessionId: id as never,
      variant: 'hero',
      disabled: true,
      onRequestWorkspace: () => {},
      placeholder: 'workspace',
    })
    expect(element.type).toBe(f.original)
    expect(element.props.disabled).toBe(false)
    expect(element.props.onRequestWorkspace).toBeUndefined()
    expect(element.props.placeholder).toBeUndefined()
    expect(f.entries()).toEqual([entry])
    expect(f.core.spec('conversation.input.right')).toBeDefined()
    dispose()
    expect(entry.component).toBe(f.original)
  })

  it('waits for the official entry when the declaration precedes registration', async () => {
    const f = fixture()
    const dispose = f.install()
    f.register()
    await Promise.resolve()
    expect(f.entries()[0]!.component).not.toBe(f.original)
    dispose()
    expect(f.entries()[0]!.component).toBe(f.original)
  })

  it('keeps the official blank-home workspace trigger before Session creation', () => {
    const f = fixture()
    f.register()
    const dispose = f.install()
    const regular = { variant: 'hero' as const, disabled: true, onRequestWorkspace: () => {} }
    const home = render(f, regular)
    expect(home.type).toBe(f.original)
    expect(home.props).toEqual({ ...liveProps, ...regular })
    const restored = {
      sessionId: 'session-restored-without-workspace' as never,
      variant: 'hero' as const,
      disabled: true,
      onRequestWorkspace: () => {},
      placeholder: 'workspace',
    }
    markProjectlessSession(restored.sessionId)
    expect(render(f, restored).props).toMatchObject({
      sessionId: restored.sessionId,
      variant: restored.variant,
      disabled: false,
    })
    expect(render(f, restored).props.onRequestWorkspace).toBeUndefined()
    expect(render(f, regular).props).toEqual({ ...liveProps, ...regular })
    const id = 'session-projectless-restricted'
    markProjectlessSession(id)
    const restricted = { sessionId: id as never, variant: 'composer' as const, disabled: true }
    expect(render(f, restricted).props).toEqual({ ...liveProps, ...restricted })
    dispose()
  })

  it('keeps a live workspace composer and explicit submission blocks unchanged', () => {
    const f = fixture()
    f.register()
    const dispose = f.install()
    const workspace = { sessionId: 'workspace-session' as never, variant: 'composer' as const }
    expect(render(f, workspace).type).toBe(f.original)
    expect(render(f, workspace).props).toEqual({ ...liveProps, ...workspace })
    const blocked = {
      ...workspace,
      disabled: true,
      onRequestWorkspace: () => {},
      blocked: { reason: 'waiting for approval' },
    }
    expect(render(f, blocked).props).toEqual({ ...liveProps, ...blocked })
    dispose()
  })

  it('waits for the input binding after Session identity restoration', () => {
    const f = fixture()
    f.register()
    const dispose = f.install()
    const session = { sessionId: 'restoring' as never, variant: 'hero' as const }
    for (const absent of [
      { useInput: () => undefined },
      { keyboard: undefined },
      { inputActions: undefined },
    ]) {
      expect(render(f, { ...session, ...absent }).props.role).toBe('status')
    }
    dispose()
  })

  it('transitions from restoration to the resident composer on the input notification', async () => {
    const dom = createTestDom()
    const container = dom.document.createElement('div')
    const root = createRoot(container as unknown as HTMLElement)
    const f = fixture()
    f.register()
    const entry = f.entries()[0]!
    entry.component = memo((props: ComposerBarProps) =>
      createElement('textarea', { disabled: props.disabled, placeholder: props.placeholder }),
    )
    const dispose = f.install()
    let input: object | undefined
    const listeners = new Set<() => void>()
    const useInput = ((select: (value: object | undefined) => unknown) =>
      select(
        useSyncExternalStore(
          (notify) => {
            listeners.add(notify)
            return () => {
              listeners.delete(notify)
            }
          },
          () => input,
        ),
      )) as ComposerBarProps['useInput']
    const props = {
      ...liveProps,
      useInput,
      variant: 'hero',
      disabled: true,
      onRequestWorkspace: () => {},
      placeholder: '选择一个工作区开始',
    } as ComposerBarProps
    try {
      await act(async () => root.render(createElement(entry.component, props)))
      expect(container.textContent).toBe('')
      expect(container.firstChild?.nodeName).toBe('TEXTAREA')
      expect(container.firstChild?.getAttribute('disabled')).not.toBeNull()
      expect(container.firstChild?.getAttribute('placeholder')).toBe('选择一个工作区开始')
      markProjectlessSession('restored-session')
      await act(async () =>
        root.render(
          createElement(entry.component, {
            ...props,
            sessionId: 'restored-session' as never,
          }),
        ),
      )
      expect(container.textContent).toBe('正在恢复会话…')
      await act(async () => {
        input = {}
        for (const notify of listeners) notify()
      })
      expect(container.textContent).not.toContain('正在恢复会话')
      expect(container.firstChild?.nodeName).toBe('TEXTAREA')
      expect(container.firstChild?.getAttribute('disabled')).toBeNull()
      expect(container.firstChild?.getAttribute('placeholder')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      dispose()
    }
  })

  it('restores an unloaded entry and decorates its replacement', async () => {
    const f = fixture()
    const unregister = f.register()
    const first = f.entries()[0]!
    const dispose = f.install()
    unregister()
    f.register()
    await Promise.resolve()
    expect(first.component).toBe(f.original)
    expect(f.entries()[0]!.component).not.toBe(f.original)
    dispose()
  })
})

describe('official ungrouped sidebar action adapter', () => {
  it('routes only the ungrouped new-session button through projectless start', async () => {
    const core = new SlotCore()
    core.register(
      {
        name: 'root',
        children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' } },
      },
      () => null,
    )
    const original = (props: { startSession: () => void }) =>
      createElement(
        'section',
        null,
        createElement(
          'div',
          { 'data-row-key': 'workspace:' },
          createElement('button', { 'aria-label': '新建会话（未分组）' }, 'plus'),
        ),
        createElement(
          'div',
          { 'data-row-key': 'workspace:real' },
          createElement('button', { 'aria-label': '新建会话（工作区）' }, 'plus'),
        ),
      )
    core.register({ name: 'sidebar.workspaces' }, original)
    const startSession = vi.fn()
    const dispose = installProjectlessUngroupedPlus(
      () => core.entries('sidebar.workspaces'),
      (listener) => core.subscribe('sidebar.workspaces', listener),
    )
    const element = (core.entries('sidebar.workspaces')[0]!.component as never)({
      startSession,
    }) as ReactElement<{
      onClickCapture: (event: unknown) => void
      style: Record<string, string | number>
    }>
    expect(element.props.style).toMatchObject({ display: 'flex', minHeight: 0 })
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const ungroupedButton = {
      getAttribute: () => '新建会话（未分组）',
      closest: (selector: string) => (selector === '[data-row-key="workspace:"]' ? {} : null),
    }
    element.props.onClickCapture({
      target: { closest: () => ungroupedButton },
      preventDefault,
      stopPropagation,
    })
    expect(startSession).toHaveBeenCalledExactlyOnceWith('', {
      clearPreviousDraft: true,
    })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    dispose()
  })
})
