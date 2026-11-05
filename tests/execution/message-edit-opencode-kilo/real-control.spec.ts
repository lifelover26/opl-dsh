import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type { ExternalEditContext } from '../../../src/execution/host/message-edit-driver.ts'
import type { AdapterLaunch } from '../../../src/execution/host/adapters/types.ts'
import { createOpenCodeMessageEditDriver } from '../../../src/execution/host/message-edit-opencode.ts'
import { createKiloMessageEditDriver } from '../../../src/execution/host/message-edit-kilo.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-serve.mjs', import.meta.url))
const TMP_ROOT =
  process.env.OPL_MESSAGE_EDIT_TMP ?? join(tmpdir(), 'opl-message-edit-opencode-kilo')
mkdirSync(TMP_ROOT, { recursive: true })

type Kind = 'opencode' | 'kilo'

function messages() {
  return [
    {
      info: { id: 'msg_a', role: 'user', sessionID: 'ses_current', time: { created: 1 } },
      parts: [
        { type: 'text', id: 'prt_a', messageID: 'msg_a', sessionID: 'ses_current', text: 'alpha' },
      ],
    },
    {
      info: { id: 'msg_b', role: 'user', sessionID: 'ses_current', time: { created: 2 } },
      parts: [
        { type: 'text', id: 'prt_b', messageID: 'msg_b', sessionID: 'ses_current', text: 'beta' },
      ],
    },
  ]
}

function contextFor(
  kind: Kind,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal = new AbortController().signal,
): ExternalEditContext {
  const record = {
    id: 'record-1',
    combination: 'probe',
    harnessRef: kind,
    modelRef: { provider: 'probe', model: 'probe' },
    cwd: TMP_ROOT,
    acpSessionId: 'ses_current',
    origin: { kind: 'desktop', sessionId: 'dsh-sidebar-1' },
    title: 'probe',
    sandbox: 'full-access',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    turns: [],
  } as unknown as HarnessSession
  const launch: AdapterLaunch = {
    home: TMP_ROOT,
    command: process.execPath,
    args: [],
    env: {
      ...env,
      OPL_CHAT_COMMAND: process.execPath,
      OPL_CHAT_ARGS: JSON.stringify([FIXTURE]),
      OPL_CHAT_VERBATIM: '0',
    },
  }
  return {
    record,
    launch,
    signal,
    transport: () => ({ request: async () => ({}) }),
    snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
    disconnect: async () => {},
    reconnect: async () => {},
  }
}

function driverFor(kind: Kind) {
  return kind === 'opencode' ? createOpenCodeMessageEditDriver() : createKiloMessageEditDriver()
}

describe('external message-edit driver real control path', () => {
  it('uses the registered CLI binding when ACP is launched through a Windows wrapper', async () => {
    const dir = mkdtempSync(join(TMP_ROOT, 'registered-launch-'))
    const context = contextFor('opencode', {
      FAKE_VENDOR_KIND: 'opencode',
      FAKE_VENDOR_MESSAGES: JSON.stringify(messages()),
      FAKE_PID_FILE: join(dir, 'pid'),
    })
    context.launch.env.OPL_CHAT_COMMAND = 'cmd.exe'
    context.launch.env.OPL_CHAT_ARGS = JSON.stringify(['/d', '/s', '/c', 'opaque-acp-wrapper'])
    context.launch.env.OPL_CHAT_EDIT_COMMAND = process.execPath
    context.launch.env.OPL_CHAT_EDIT_ARGS = JSON.stringify([FIXTURE])
    expect((await driverFor('opencode').read(context)).boundaries).toHaveLength(2)
    expect(() => process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')), 0)).toThrow()
  })
  it.each(['opencode', 'kilo'] as const)(
    '%s authenticates, reads, forks, and cleans up the owned serve',
    async (kind) => {
      const dir = mkdtempSync(join(TMP_ROOT, `${kind}-`))
      const pidFile = join(dir, 'pid')
      const context = contextFor(kind, {
        FAKE_VENDOR_KIND: kind,
        FAKE_VENDOR_MESSAGES: JSON.stringify(messages()),
        FAKE_PID_FILE: pidFile,
      })
      const driver = driverFor(kind)
      const history = await driver.read(context)
      const firstPid = Number(readFileSync(pidFile, 'utf8'))
      expect(history.boundaries).toEqual([
        { id: 'msg_a', text: 'alpha' },
        { id: 'msg_b', text: 'beta' },
      ])
      const result = await driver.rewind(context, {
        operationId: 'op-1',
        targetId: 'msg_b',
        expected: history,
      })
      const secondPid = Number(readFileSync(pidFile, 'utf8'))
      expect(result.retained).toEqual([{ previousId: 'msg_a', nextId: result.retained[0]!.nextId }])
      expect(result.sessionId).toMatch(/^ses_fake_/)
      expect(() => process.kill(firstPid, 0)).toThrow()
      expect(() => process.kill(secondPid, 0)).toThrow()
    },
  )

  it.each(['opencode', 'kilo'] as const)(
    '%s refuses a busy vendor and closes the owned serve without forking',
    async (kind) => {
      const dir = mkdtempSync(join(TMP_ROOT, `${kind}-busy-`))
      const pidFile = join(dir, 'pid')
      const enteredFile = join(dir, 'fork-entered')
      const context = contextFor(kind, {
        FAKE_VENDOR_KIND: kind,
        FAKE_VENDOR_MESSAGES: JSON.stringify(messages()),
        FAKE_VENDOR_STATUSES: JSON.stringify({ ses_current: { type: 'busy' } }),
        FAKE_PID_FILE: pidFile,
        FAKE_FORK_ENTERED_FILE: enteredFile,
      })
      await expect(driverFor(kind).read(context)).rejects.toMatchObject({ code: 'busy' })
      expect(existsSync(enteredFile)).toBe(false)
      expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow()
    },
  )

  it('fails closed when the owned serve exits before listening', async () => {
    const dir = mkdtempSync(join(TMP_ROOT, 'early-exit-'))
    const context = contextFor('opencode', {
      FAKE_VENDOR_KIND: 'opencode',
      FAKE_VENDOR_MESSAGES: JSON.stringify(messages()),
      FAKE_PID_FILE: join(dir, 'pid'),
      FAKE_EXIT_EARLY: '1',
    })
    await expect(driverFor('opencode').read(context)).rejects.toMatchObject({
      code: 'control-unavailable',
    })
  })

  it('marks an aborted fork as uncertain without retrying', async () => {
    const dir = mkdtempSync(join(TMP_ROOT, 'abort-'))
    const controller = new AbortController()
    const enteredFile = join(dir, 'fork-entered')
    const entered = new Promise<void>((resolve, reject) => {
      const watcher = watch(dir, () => {
        if (existsSync(enteredFile)) {
          clearTimeout(timer)
          watcher.close()
          resolve()
        }
      })
      const timer = setTimeout(() => {
        watcher.close()
        reject(Error('fork request never reached fixture'))
      }, 15_000)
    })
    const context = contextFor(
      'opencode',
      {
        FAKE_VENDOR_KIND: 'opencode',
        FAKE_VENDOR_MESSAGES: JSON.stringify(messages()),
        FAKE_PID_FILE: join(dir, 'pid'),
        FAKE_FORK_DELAY_MS: '800',
        FAKE_FORK_ENTERED_FILE: enteredFile,
      },
      controller.signal,
    )
    const driver = driverFor('opencode')
    const history = await driver.read(context)
    const pending = driver.rewind(context, {
      operationId: 'op-1',
      targetId: 'msg_b',
      expected: history,
    })
    await entered
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'uncertain' })
  })
})
