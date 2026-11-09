import { afterAll, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
const held = vi.hoisted(() => ({
  shell: undefined as undefined | (() => Promise<{ env: Record<string, string>; shell: string }>),
}))
vi.mock('../../../src/execution/host/adapters/step/step-bash.ts', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  stepBashEnvironment: () =>
    held.shell?.() ?? Promise.resolve({ env: {}, shell: 'C:/Program Files/Git/bin/bash.exe' }),
}))
import { createStepCodeAdapter } from '../../../src/execution/host/adapters/step/step.ts'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { stepRecord } from './fixtures/records.ts'
const home = mkdtempSync(join(tmpdir(), 'opl-step-chief-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const model = 'step-5-preview-free',
  ref = { provider: 'our-free-model', model }
const record = stepRecord(ref, { acpSessionId: 'chief-step', reasoningEffort: 'high' })
const adapter = createStepCodeAdapter('C:/owned/step-bridge.mjs')
const ctx = { effect: (fn: () => unknown) => fn() } as never
const options = (s: ExternalModelSources) =>
  ({
    command: process.execPath,
    home,
    modelSources: s,
  }) as never
const config = (m: string, thinking: string) => [
  { id: 'model', currentValue: m, options: [{ value: model }] },
  { id: 'thinking', currentValue: thinking, options: [{ value: 'high' }] },
]
function sources() {
  const s = new ExternalModelSources(ctx)
  const revoke = s.register(ctx, {
    provider: ref.provider,
    supports: () => true,
    resolve: async () => ({
      model,
      protocol: 'chat',
      baseURL: 'http://127.0.0.1:49152/v1',
      apiKey: 'dummy-chief-step-key',
    }),
  })
  return { s, revoke }
}
describe('Chief Step final checks', () => {
  it('rejects missing config advertisements', () => {
    expect(() => adapter.verifySession!(record, { agent: {} })).toThrow()
  })
  it('rejects model drift in final thinking response', async () => {
    let calls = 0
    const acp = {
      request: async () => ({
        configOptions: ++calls === 1 ? config(model, 'off') : config('other-model', 'high'),
      }),
    }
    const rejected = await adapter.configureSession!(acp, record, {
      agent: {},
      session: { sessionId: 'chief-step' },
      configOptions: config(model, 'off'),
    }).then(
      () => false,
      () => true,
    )
    expect(rejected).toBe(true)
  })
  it('rejects unregister during Bash preflight', async () => {
    let enter!: () => void, release!: () => void
    const started = new Promise<void>((r) => (enter = r)),
      gate = new Promise<void>((r) => (release = r))
    held.shell = async () => {
      enter()
      await gate
      return { env: {}, shell: 'C:/Program Files/Git/bin/bash.exe' }
    }
    const { s, revoke } = sources()
    const rejected = adapter.prepare!(ctx, record, options(s)).then(
      () => false,
      () => true,
    )
    await started
    revoke()
    release()
    try {
      expect(await rejected).toBe(true)
    } finally {
      held.shell = undefined
    }
  })
  it('keeps HOME unchanged when official profile variables exist', async () => {
    const { s } = sources()
    const launch = await adapter.prepare!(ctx, record, options(s))
    expect(Object.hasOwn(launch.env, 'HOME')).toBe(false)
  })
  it('relays a permission-like select during a running task instead of auto-answering by title text', () => {
    const source = readFileSync(
      new URL('../../../src/execution/host/adapters/step/step-bridge.ts', import.meta.url),
      'utf8',
    )
    const start = source.indexOf('function handleDialog('),
      end = source.indexOf('/** Resolve the pending permission asks', start)
    const code = transformSync(source.slice(start, end), { loader: 'ts', target: 'es2024' }).code
    const writes: string[] = [],
      requests: unknown[] = []
    const env = {
      acknowledgeFullAccess: true,
      DIALOG_METHODS: new Set(['select']),
      FULL_ACCESS_OPTION: 'apply full access for this session',
      child: { stdin: { write: (v: string) => writes.push(v) } },
      send: (v: unknown) => requests.push(v),
      redact: (v: string) => v,
      asks: new Map(),
      seq: 0,
      sessionId: 'chief-step',
      resolveTurn: () => {},
    }
    runInNewContext(
      code +
        '\nhandleDialog({id:"task-dialog",method:"select",title:"Full Access",message:"task tool permission",options:["apply full access for this session"]})',
      env,
    )
    expect(writes.length).toBe(0)
    expect(requests.length).toBe(1)
  })
})
