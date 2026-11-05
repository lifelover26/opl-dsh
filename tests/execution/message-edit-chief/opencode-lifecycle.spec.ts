import { expect, it, vi } from 'vitest'
import { createOpenCodeMessageEditDriver } from '../../../src/execution/host/message-edit-opencode.ts'
import type { ExternalEditContext } from '../../../src/execution/host/message-edit-driver.ts'

const context = {
  record: { harnessRef: 'opencode', acpSessionId: 'old', turns: [] },
  signal: new AbortController().signal,
  disconnect: async () => {},
} as unknown as ExternalEditContext
const message = {
  info: { id: 'u', role: 'user', sessionID: 'old' },
  parts: [{ type: 'text', text: 'question' }],
}
it('refuses successful history read when the owned control process cannot close', async () => {
  const driver = createOpenCodeMessageEditDriver(async () => ({
    readMessages: async () => [message],
    fork: async () => ({ sessionId: 'new' }),
    close: async () => {
      throw Error('owned control still running')
    },
  }))
  await expect(driver.read(context)).rejects.toThrow()
})
it('does not report successful fork when control cleanup fails after mutation', async () => {
  let failingClose = false
  const fork = vi.fn(async () => ({ sessionId: 'new' }))
  const driver = createOpenCodeMessageEditDriver(async () => ({
    readMessages: async (id) => (id === 'old' ? [message] : []),
    fork,
    close: async () => {
      if (failingClose) throw Error('owned control still running')
    },
  }))
  const expected = await driver.read(context)
  failingClose = true
  await expect(
    driver.rewind(context, { operationId: 'edit', targetId: 'u', expected }),
  ).rejects.toThrow()
  expect(fork).toHaveBeenCalledOnce()
})
