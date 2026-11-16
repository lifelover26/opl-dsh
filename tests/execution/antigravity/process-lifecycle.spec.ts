import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { runAntigravityBridge } from '../../../src/execution/host/adapters/antigravity/bridge.ts'

type Message = Record<string, any> // Untrusted ACP fixture messages.
const treeCli = fileURLToPath(new URL('./fixtures/agy-process-tree.mjs', import.meta.url))

async function bridge(shim: boolean = false) {
  const root = await mkdtemp(join(tmpdir(), 'opl-agy-process-'))
  const input = new PassThrough()
  const output = new PassThrough()
  const messages: Message[] = []
  const listeners = new Set<() => void>()
  const lines = createInterface({ input: output })
  lines.on('line', (line) => {
    messages.push(JSON.parse(line))
    for (const notify of listeners) notify()
  })
  const command = shim ? join(root, 'official shim.cmd') : process.execPath
  if (shim) await writeFile(command, `@echo off\r\n"${process.execPath}" "${treeCli}" %*\r\n`)
  let disposed = false
  const running = runAntigravityBridge({
    input,
    output,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      OPL_AGY_COMMAND: command,
      OPL_AGY_ARGS: JSON.stringify(shim ? [] : [treeCli]),
      OPL_AGY_ROUTE: JSON.stringify({
        baseURL: 'http://127.0.0.1:1',
        model: 'gemini-4-carbon',
        apiKey: 'fixture-only',
        protocol: 'gemini-native',
      }),
      OPL_AGY_PROFILE: root,
      OPL_AGY_WORKSPACE: root,
      OPL_AGY_NODE: process.execPath,
    },
    prepareShell: async ({ env }) => ({
      env: { ...env },
      args: [],
      verify: async () => {},
      invalidateInvocation: async () => {},
      verifyInvocation: async () => {},
      executions: async () => [],
      dispose: async () => {
        disposed = true
      },
    }),
  })
  // Capture rejection immediately so a failed fixture never leaves an unhandled rejection.
  const completed = running.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  )
  const wait = async (predicate: (message: Message) => boolean) => {
    const existing = messages.find(predicate)
    if (existing) return existing
    return new Promise<Message>((resolve, reject) => {
      const notify = () => {
        const found = messages.find(predicate)
        if (!found) return
        clearTimeout(timer)
        listeners.delete(notify)
        resolve(found)
      }
      const timer = setTimeout(() => {
        listeners.delete(notify)
        reject(Error('Antigravity process fixture did not answer'))
      }, 6000)
      listeners.add(notify)
    })
  }
  let sequence = 0
  const send = (message: object) => input.write(JSON.stringify(message) + '\n')
  const request = async (method: string, params: object = {}) => {
    const id = ++sequence
    send({ id, method, params })
    return wait((message) => message.id === id && !message.method)
  }
  return {
    root,
    input,
    send,
    wait,
    request,
    completed,
    disposed: () => disposed,
    async close() {
      input.end()
      const result = await completed
      lines.close()
      output.end()
      await rm(root, { recursive: true, force: true })
      if (result.error) throw result.error
    },
  }
}

it.runIf(process.platform !== 'win32').each([
  ['leader-exit', false],
  ['cancel', false],
  ['leader-exit', true],
] as const)(
  'stops a TERM-resistant tool before settling when the CLI %s (EPERM probe: %s)',
  async (mode, deniedProbe) => {
    const fixture = await bridge()
    let pids: { leader: number; tool: number } | undefined
    const nativeKill = process.kill.bind(process)
    let injectedProbe = false
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (deniedProbe && !injectedProbe && pids && pid === -pids.leader && signal === 0) {
        injectedProbe = true
        throw Object.assign(Error('kill EPERM'), { code: 'EPERM' })
      }
      return nativeKill(pid, signal)
    })
    try {
      await fixture.request('initialize')
      await fixture.request('session/new', { cwd: fixture.root })
      const prompt = fixture.request('session/prompt', {
        sessionId: 'owned-tree-session',
        prompt: [{ type: 'text', text: mode }],
      })
      const update = await fixture.wait((message) => message.method === 'session/update')
      pids = JSON.parse(update.params.update.content.text)
      expect(() => process.kill(pids!.tool, 0)).not.toThrow()
      if (mode === 'cancel')
        fixture.send({ method: 'session/cancel', params: { sessionId: 'owned-tree-session' } })
      const result = await prompt
      expect(() => process.kill(pids!.tool, 0)).toThrow()
      expect(fixture.disposed()).toBe(true)
      if (mode === 'cancel') expect(result.result.stopReason).toBe('cancelled')
      else
        expect(result.error.data).toMatchObject({
          oplTurnSettled: true,
          errorName: 'processExited',
        })
      expect((await fixture.completed).error).toBeUndefined()
      expect(injectedProbe).toBe(deniedProbe)
    } finally {
      kill.mockRestore()
      // A failing regression must not leave its deliberately persistent tool running.
      if (pids) {
        try {
          process.kill(-pids.leader, 'SIGKILL')
        } catch {}
      }
      await fixture.close()
    }
  },
  12_000,
)

it.runIf(process.platform === 'win32')(
  'starts a valid discovered Windows cmd entry point',
  async () => {
    const fixture = await bridge(true)
    try {
      expect((await fixture.request('initialize')).result.protocolVersion).toBe(1)
      expect((await fixture.request('session/new', { cwd: fixture.root })).result.sessionId).toBe(
        'owned-tree-session',
      )
    } finally {
      await fixture.close()
    }
  },
  12_000,
)
