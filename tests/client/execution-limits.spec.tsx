import { JSDOM } from 'jsdom'
import { act, createElement, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Switch: ({
    checked,
    disabled,
    label,
    onChange,
  }: {
    checked: boolean
    disabled: boolean
    label: string
    onChange(value: boolean): void
  }) =>
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': label,
      checked,
      disabled,
      onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked),
    }),
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement('button', props, children),
}))

it('shows OPL deadlines disabled and saves the explicit opt-in alongside durations', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const { createRoot } = await import('react-dom/client')
  const { ExecutionLimitsSection } =
    await import('../../src/execution/client/ExecutionLimitsSection.tsx')
  const initial = { enabled: false, firstProgressMs: 90_000, idleProgressMs: 90_000 }
  const call = vi.fn(async (method: string, value?: unknown) =>
    method === 'execution-limits' ? initial : value,
  )
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        createElement(ExecutionLimitsSection, { call: call as unknown as ExecutionCall }),
      ),
    )
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.checked).toBe(false)
    expect(container.textContent).toContain('启用 OPL 进展超时')
    await act(async () => checkbox.click())
    expect(checkbox.checked).toBe(true)
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '保存等待设置',
    )!
    await act(async () => save.click())
    expect(call).toHaveBeenCalledWith('save-execution-limits', { ...initial, enabled: true })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
