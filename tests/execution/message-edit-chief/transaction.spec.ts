import { describe, expect, it, vi } from 'vitest'
import {
  ExternalMessageEditTransactions,
  type ExternalEditIntent,
  type ExternalEditJournal,
} from '../../../src/execution/host/message-edit-external.ts'
import type {
  ExternalEditContext,
  ExternalEditResult,
} from '../../../src/execution/host/message-edit-driver.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'

function setup() {
  const rows = new Map<string, ExternalEditIntent>()
  const journal: ExternalEditJournal = {
    get: (id) => rows.get(id),
    save: async (row) => {
      rows.set(row.sessionId, structuredClone(row))
    },
  }
  const record: HarnessSession = {
    id: 'record',
    nativeSessionId: 'dsh',
    acpSessionId: 'vendor',
    harnessRef: 'codex',
    combination: 'combination',
    modelRef: { provider: 'fixture', model: 'fixture' },
    cwd: '/work',
    origin: { kind: 'dsh', sessionId: 'dsh' },
    sandbox: 'full-access',
    title: 'fixture',
    createdAt: 'now',
    updatedAt: 'now',
    turns: [],
  }
  const abort = new AbortController()
  const context: ExternalEditContext = {
    record,
    signal: abort.signal,
    launch: { home: '/fixture', command: 'fixture', args: [], env: {} },
    transport: () => ({ request: async () => ({}) }),
    snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
    disconnect: async () => {},
    reconnect: async () => {},
  }
  const expected = { sessionId: 'vendor', token: 'one', boundaries: [{ id: 'a' }, { id: 'b' }] }
  const input = { requestId: 'edit', targetId: 'b', expected }
  const result: ExternalEditResult = {
    sessionId: 'fork',
    retained: [{ previousId: 'a', nextId: 'c' }],
  }
  const rewind = vi.fn(async () => structuredClone(result))
  return {
    rows,
    journal,
    context,
    record,
    abort,
    input,
    result,
    rewind,
    driver: { read: async () => expected, rewind },
    tx: new ExternalMessageEditTransactions(journal),
  }
}

describe('external edit admission', () => {
  it('journals a fresh first input before allocating and does not repeat a lost response', async () => {
    const s = setup()
    const allocate = vi.fn(async () => {
      expect(s.rows.get('dsh')?.phase).toBe('invoking')
      throw Error('allocation response lost')
    })
    await expect(
      s.tx.prepareFirst(s.context, { requestId: 'first-edit', targetSeq: 7 }, allocate),
    ).rejects.toThrow('allocation response lost')
    const restarted = new ExternalMessageEditTransactions(s.journal)
    await expect(
      restarted.prepareFirst(s.context, { requestId: 'first-edit', targetSeq: 7 }, allocate),
    ).rejects.toThrow('尚未确认')
    expect(allocate).toHaveBeenCalledTimes(1)
  })

  it('requires a fresh empty identity and preserves the original vendor binding', async () => {
    const s = setup()
    const result = await s.tx.prepareFirst(
      s.context,
      { requestId: 'first-edit', targetSeq: 7 },
      async () => ({ sessionId: 'empty-fork', retained: [], ephemeral: true }),
    )
    expect(result).toEqual({ sessionId: 'empty-fork', retained: [], ephemeral: true })
    expect(s.record.acpSessionId).toBe('vendor')
    expect(s.tx.intent('dsh')).toMatchObject({ targetId: 'dsh-user:7', phase: 'ready' })
    const other = setup()
    await expect(
      other.tx.prepareFirst(other.context, { requestId: 'first-edit', targetSeq: 7 }, async () => ({
        sessionId: 'vendor',
        retained: [],
      })),
    ).rejects.toThrow('未创建新的空会话')
    expect(other.tx.pending('dsh')).toBe(true)
  })
  it('settles a replacement on a terminal Harness error but keeps transport loss uncertain', async () => {
    const s = setup()
    await s.tx.prepare(s.context, s.driver, s.input)
    await expect(
      s.tx.admit('dsh', 'edit', async () => {
        throw Object.assign(Error('quota'), { promptSettled: true })
      }),
    ).rejects.toThrow('quota')
    expect(s.rows.get('dsh')?.phase).toBe('settled')
    const u = setup()
    await u.tx.prepare(u.context, u.driver, u.input)
    await expect(
      u.tx.admit('dsh', 'edit', async () => {
        throw Error('connection lost')
      }),
    ).rejects.toThrow('connection lost')
    expect(u.rows.get('dsh')?.phase).toBe('uncertain')
  })
  it('does not repeat an empty allocation whose response was lost', async () => {
    const s = setup()
    s.result.retained = []
    s.result.ephemeral = true
    s.input.targetId = 'a'
    await s.tx.prepare(s.context, s.driver, s.input)
    await s.tx.admit('dsh', 'edit', async () => {})
    s.record.acpSessionId = 'fork'
    const allocate = vi.fn(async () => {
      throw Error('lost allocation response')
    })
    await expect(s.tx.reuseUnsent(s.context, 'edit', 'next', allocate)).rejects.toThrow(
      'lost allocation',
    )
    const restarted = new ExternalMessageEditTransactions(s.journal)
    await expect(restarted.reuseUnsent(s.context, 'next', 'third', allocate)).rejects.toThrow()
    expect(allocate).toHaveBeenCalledTimes(1)
    expect(restarted.pending('dsh')).toBe(true)
  })
  it('reuses an unsent fork for a new edit without repeating the vendor rewind', async () => {
    const s = setup()
    await s.tx.prepare(s.context, s.driver, s.input)
    await s.tx.admit('dsh', 'edit', async () => {})
    s.record.acpSessionId = 'fork'
    const result = await s.tx.reuseUnsent(s.context, 'edit', 'changed-edit')
    expect(result).toEqual(s.result)
    expect(s.rewind).toHaveBeenCalledTimes(1)
    const restarted = new ExternalMessageEditTransactions(s.journal)
    await restarted.admit('dsh', 'changed-edit', async () =>
      restarted.beginPrompt('dsh', 'changed-edit'),
    )
    await expect(restarted.reuseUnsent(s.context, 'changed-edit', 'third')).rejects.toThrow()
    await restarted.settle('dsh', 'changed-edit')
    expect(restarted.pending('dsh')).toBe(false)
  })
  it('accepts connection observation timestamps but rejects changed binding facts', async () => {
    const s = setup()
    s.rewind.mockImplementation(async () => {
      s.record.updatedAt = 'connection reopened'
      return structuredClone(s.result)
    })
    await expect(s.tx.prepare(s.context, s.driver, s.input)).resolves.toEqual(s.result)
    const changed = setup()
    changed.rewind.mockImplementation(async () => {
      changed.record.sandbox = 'read-only'
      return structuredClone(changed.result)
    })
    await expect(
      changed.tx.prepare(changed.context, changed.driver, changed.input),
    ).rejects.toThrow('绑定已变化')
  })
  it('persists invoking before vendor mutation and never replays a crashed invocation', async () => {
    const s = setup()
    s.rewind.mockImplementation(async () => {
      expect(s.rows.get('dsh')?.phase).toBe('invoking')
      throw Error('connection lost after mutation')
    })
    await expect(s.tx.prepare(s.context, s.driver, s.input)).rejects.toThrow('connection lost')
    const restarted = new ExternalMessageEditTransactions(s.journal)
    await expect(restarted.prepare(s.context, s.driver, s.input)).rejects.toThrow('尚未确认')
    expect(s.rewind).toHaveBeenCalledTimes(1)
    expect(restarted.pending('dsh')).toBe(true)
  })
  it('does not call vendor if intent persistence fails', async () => {
    const s = setup()
    s.journal.save = async () => {
      throw Error('disk unavailable')
    }
    await expect(s.tx.prepare(s.context, s.driver, s.input)).rejects.toThrow('disk unavailable')
    expect(s.rewind).not.toHaveBeenCalled()
  })
  it('reuses only the exact ready request and preserves DSH identity', async () => {
    const s = setup()
    expect(await s.tx.prepare(s.context, s.driver, s.input)).toEqual(s.result)
    expect(await s.tx.prepare(s.context, s.driver, s.input)).toEqual(s.result)
    await expect(
      s.tx.prepare(s.context, s.driver, { ...s.input, requestId: 'other' }),
    ).rejects.toThrow()
    expect(s.rewind).toHaveBeenCalledTimes(1)
    expect(s.record.nativeSessionId).toBe('dsh')
    expect(s.record.acpSessionId).toBe('vendor')
  })
  it('blocks if binding changed during vendor mutation', async () => {
    const s = setup()
    s.rewind.mockImplementation(async () => {
      s.record.reasoningEffort = 'low'
      return s.result
    })
    await expect(s.tx.prepare(s.context, s.driver, s.input)).rejects.toThrow('绑定已变化')
    expect(s.rows.get('dsh')?.phase).toBe('uncertain')
  })
  it('blocks an aborted mutation even after the vendor returned success', async () => {
    const s = setup()
    s.rewind.mockImplementation(async () => {
      s.abort.abort()
      return s.result
    })
    await expect(s.tx.prepare(s.context, s.driver, s.input)).rejects.toThrow()
    expect(s.tx.pending('dsh')).toBe(true)
  })
  it.each(['abort', 'binding'] as const)(
    'blocks %s during the durable result save',
    async (change) => {
      const s = setup()
      const save = s.journal.save
      s.journal.save = async (row) => {
        await save(row)
        if (row.phase === 'ready') {
          if (change === 'abort') s.abort.abort()
          else s.record.acpSessionId = 'other-vendor'
        }
      }
      await expect(s.tx.prepare(s.context, s.driver, s.input)).rejects.toThrow()
      expect(s.rows.get('dsh')?.phase).toBe('uncertain')
      expect(s.rewind).toHaveBeenCalledTimes(1)
      expect(s.tx.pending('dsh')).toBe(true)
    },
  )
  it('rejects a retained mapping that silently drops an old input', async () => {
    const s = setup()
    s.rewind.mockResolvedValue({ sessionId: 'fork', retained: [] })
    await expect(s.tx.prepare(s.context, s.driver, s.input)).rejects.toThrow('历史映射不一致')
  })
  it('rejects overlapping admission while the journal write is pending', async () => {
    const s = setup()
    await s.tx.prepare(s.context, s.driver, s.input)
    const originalSave = s.journal.save
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    s.journal.save = async (row) => {
      await blocked
      await originalSave(row)
    }
    const send = vi.fn(async () => {})
    const first = s.tx.admit('dsh', 'edit', send)
    await expect(s.tx.admit('dsh', 'edit', send)).rejects.toThrow('正在处理')
    release()
    await first
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('allows only one replacement transport admission and waits for terminal observation', async () => {
    const s = setup()
    await s.tx.prepare(s.context, s.driver, s.input)
    const send = vi.fn(async () => s.tx.beginPrompt('dsh', 'edit'))
    await s.tx.admit('dsh', 'edit', send)
    expect(s.tx.pending('dsh')).toBe(true)
    await expect(s.tx.beginPrompt('dsh', 'edit')).rejects.toThrow()
    await expect(s.tx.admit('dsh', 'edit', send)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
    await s.tx.settle('dsh', 'edit')
    expect(s.tx.pending('dsh')).toBe(false)
    await expect(s.tx.prepare(s.context, s.driver, s.input)).rejects.toThrow('已经使用')
  })
})
