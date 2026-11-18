// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  NativeShellPreference,
  nativeShellLabels,
  type NativeShellApi,
} from '../../src/shell/client.tsx'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Switch: ({
    checked,
    disabled,
    onChange,
    label,
  }: {
    checked: boolean
    disabled: boolean
    onChange(value: boolean): void
    label: string
  }) => (
    <input
      aria-label={label}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  ),
}))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
async function mount(api: NativeShellApi) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <NativeShellPreference
        api={api}
        t={((key: keyof typeof nativeShellLabels.zh) => nativeShellLabels.zh[key]) as never}
      />,
    ),
  )
  const input = () => container.querySelector('input')!
  const toggle = async () => {
    await act(async () => input().click())
  }
  return { container, input, toggle }
}
it('shows the official default and persists an explicit Git Bash selection', async () => {
  const select = vi.fn(async (enabled: boolean) => ({ available: true, enabled }))
  const view = await mount({ read: async () => ({ available: true, enabled: false }), select })
  expect(view.container.textContent).toContain('默认使用官方 PowerShell')
  expect(view.input().checked).toBe(false)
  expect(select).not.toHaveBeenCalled()
  await view.toggle()
  expect(select).toHaveBeenCalledWith(true)
  expect(view.input().checked).toBe(true)
  await view.toggle()
  expect(select).toHaveBeenLastCalledWith(false)
  expect(view.input().checked).toBe(false)
})
it('keeps the saved choice when active work refuses switching and displays the reason', async () => {
  const view = await mount({
    read: async () => ({ available: true, enabled: false }),
    select: async () => {
      throw Error('仍有任务活动')
    },
  })
  await view.toggle()
  expect(view.input().checked).toBe(false)
  expect(view.container.textContent).toContain('仍有任务活动')
})
it('displays a saved pending choice and its restart instruction', async () => {
  const view = await mount({
    read: async () => ({ available: true, enabled: false }),
    select: async () => ({ available: true, enabled: false, pending: true, desired: true }),
  })
  await view.toggle()
  expect(view.input().checked).toBe(true)
  expect(view.container.textContent).toContain('重启 OPL DSH 后生效')
})
