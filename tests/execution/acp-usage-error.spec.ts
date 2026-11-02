import { describe, expect, it } from 'vitest'
import { HarnessRequestError } from '../../src/execution/host/acp.ts'

const usage = { inputTokens: 30, outputTokens: 4, totalTokens: 44, cacheReadTokens: 10 }
const data = {
  oplTurnSettled: true,
  _meta: {
    'opl/turnUsage': { version: 1, usage },
    'opl/contextUsage': { used: 48, size: 100, estimated: true },
  },
}

describe('failed prompt accounting', () => {
  it('retains only validated owned observations, without retaining raw error data', () => {
    const error = new HarnessRequestError('fixed failure', 'session/prompt', -32603, {
      ...data,
      privateProviderDetail: 'not a display field',
    })
    expect(error.promptSettled).toBe(true)
    expect(error.statistics).toEqual({
      usage,
      contextUsage: { used: 48, size: 100, estimated: true },
    })
    expect(error).not.toHaveProperty('data')
    expect(error).not.toHaveProperty('privateProviderDetail')
  })

  it('does not mistake connection or configuration errors for completed prompt work', () => {
    for (const method of ['initialize', 'session/new', 'session/load', 'session/set_model']) {
      const error = new HarnessRequestError('fixed failure', method, -32603, data)
      expect(error.statistics).toEqual({})
      expect(error.promptSettled).toBe(false)
    }
  })

  it('rejects unversioned or inconsistent billing while keeping independently valid context', () => {
    for (const account of [
      { usage },
      { version: 2, usage },
      { version: 1, usage: { ...usage, totalTokens: 1 } },
      { version: 1, usage: { ...usage, outputTokens: '4' } },
    ]) {
      const error = new HarnessRequestError('fixed failure', 'session/prompt', -32603, {
        _meta: { ...data._meta, 'opl/turnUsage': account },
      })
      expect(error.statistics).toEqual({
        contextUsage: { used: 48, size: 100, estimated: true },
      })
    }
  })
})
