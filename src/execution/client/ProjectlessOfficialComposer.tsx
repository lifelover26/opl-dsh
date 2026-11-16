import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createElement } from 'react'
import type { ComponentType, MouseEvent } from 'react'
import type { ComposerBarProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceBrowserProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { isProjectlessSession } from './fresh-session.ts'

type ResidentComposerProps = ComposerBarProps & { readonly sessionId?: string }

/** Locale namespace for the official composer's Session restoration state. */
export const PROJECTLESS_COMPOSER_NAMESPACE = 'conversation.oplProjectlessComposer'
export const projectlessComposerZh = { restoring: '正在恢复会话…', loadingModels: '正在加载模型…' }
export const projectlessComposerEn: Record<keyof typeof projectlessComposerZh, string> = {
  restoring: 'Restoring conversation…',
  loadingModels: 'Loading models…',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'conversation.oplProjectlessComposer': keyof typeof projectlessComposerZh
  }
}

/**
 * Decorate the resident official bar while preserving its registration, injected
 * editor operations, child-slot ownership, and React memo component.
 * The slot inspection API exposes the live entry. Restore only our component
 * when its owner or this plugin unloads; do not register its child slots twice.
 * @param entries - current official composer registrations.
 * @param subscribe - official registration-change subscription.
 * @param restoringLabel - localized status after Session identity restoration, before its input binds.
 * @returns disposer restoring the resident component.
 */
export function installProjectlessOfficialComposer(
  entries: () => readonly StoredEntry[],
  subscribe: (listener: () => void) => () => void,
  restoringLabel: () => string,
): () => void {
  let restore = () => {}
  let current: StoredEntry | undefined
  const reconcile = () => {
    const entry = entries()[0]
    if (entry === current) return
    restore()
    current = entry
    if (entry === undefined) return
    const original = entry.component
    const component = original as ComponentType<ResidentComposerProps>
    const decorated = (props: ResidentComposerProps) => {
      const input = props.useInput((value) => value)
      const live =
        props.sessionId !== undefined &&
        input !== undefined &&
        props.keyboard !== undefined &&
        props.inputActions !== undefined
      // With no Session identity the official component owns the blank home:
      // its composer remains as the inert Workspace-picker trigger. Only a
      // restored identity without its input face is a restoration state.
      if (props.sessionId === undefined) return createElement(component, props)
      if (!live) {
        return createElement(
          'div',
          {
            role: 'status',
            'aria-live': 'polite',
            'aria-busy': true,
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '24px 16px' },
          },
          createElement(StateDot, { state: 'ongoing' }),
          restoringLabel(),
        )
      }
      if (props.blocked !== undefined) return createElement(component, props)
      const projectless = isProjectlessSession(props.sessionId)
      const workspaceLock =
        projectless && props.disabled === true && props.onRequestWorkspace !== undefined
      if (!workspaceLock) return createElement(component, props)
      const { onRequestWorkspace: _request, placeholder: _placeholder, ...unlocked } = props
      return createElement(component, { ...unlocked, disabled: false, workspacePickerOpen: false })
    }
    entry.component = decorated
    restore = () => {
      if (entry.component === decorated) entry.component = original
    }
  }
  const off = subscribe(reconcile)
  reconcile()
  return () => {
    off()
    restore()
  }
}

type UngroupedBrowserProps = Pick<WorkspaceBrowserProps, 'startSession'>

/**
 * Restore the official sidebar's new-session action for the ungrouped bucket.
 * The released WorkspaceBrowser renders that button but intentionally leaves its
 * `onCreate` callback empty when the group has no Workspace id. Capture only that
 * row's button and route it through the already decorated `startSession` method.
 * @param entries - current official WorkspaceBrowser registrations.
 * @param subscribe - official registration-change subscription.
 * @returns disposer restoring the resident browser component.
 */
export function installProjectlessUngroupedPlus(
  entries: () => readonly StoredEntry[],
  subscribe: (listener: () => void) => () => void,
): () => void {
  let restore = () => {}
  let current: StoredEntry | undefined
  const reconcile = () => {
    const entry = entries()[0]
    if (entry === current) return
    restore()
    current = entry
    if (entry === undefined) return
    const original = entry.component
    const component = original as ComponentType<UngroupedBrowserProps>
    const decorated = (props: UngroupedBrowserProps) => {
      const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
        const target = event.target
        if (
          target === null ||
          typeof target !== 'object' ||
          typeof (target as { closest?: unknown }).closest !== 'function'
        )
          return
        const button = (
          target as unknown as { closest: (selector: string) => Element | null }
        ).closest('button')
        if (button === null || button.closest('[data-row-key="workspace:"]') === null) return
        const label = button.getAttribute('aria-label') ?? ''
        if (!/新建会话|new session|new conversation/i.test(label)) return
        event.preventDefault()
        event.stopPropagation()
        props.startSession(undefined, { clearPreviousDraft: true })
      }
      return createElement(
        'div',
        {
          onClickCapture,
          style: {
            display: 'flex',
            flex: '1 1 auto',
            minHeight: 0,
            minWidth: 0,
            flexDirection: 'column',
          },
        },
        createElement(component, props),
      )
    }
    entry.component = decorated
    restore = () => {
      if (entry.component === decorated) entry.component = original
    }
  }
  const off = subscribe(reconcile)
  reconcile()
  return () => {
    off()
    restore()
  }
}
