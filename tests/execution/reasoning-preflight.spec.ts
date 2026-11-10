import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  probeHarnessReasoning,
  readHarnessReasoning,
} from '../../src/execution/host/reasoning-preflight.ts'
import { minimaxModelValue, minimaxReasoning } from '../../src/execution/host/adapters/minimax.ts'
import type { HarnessAdapter } from '../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { antigravityAdapter } from '../../src/execution/host/adapters/antigravity/antigravity.ts'

const authenticatedFixture = `
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
let authenticated = false
let model = 'gemini-3.1-pro'
let thinking = 'low'
const options = () => [
  { id: 'model', type: 'select', currentValue: model,
    options: ['gemini-3.1-pro', 'gemini-3.8-flash'].map(value => ({value})) },
  { id: 'thought_level', type: 'select', currentValue: thinking,
    options: ['low', 'medium', 'high'].map(value => ({value})) },
]
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  appendFileSync(process.env.PROBE_METHODS, message.method + '\\n')
  let result
  let error
  if (message.method === 'initialize')
    result = { protocolVersion: 1, authMethods: [{id: 'gemini-api-key'}] }
  else if (message.method === 'authenticate') {
    authenticated = message.params.methodId === 'gemini-api-key' && process.env.PROBE_DENY_AUTH !== '1'
    if (authenticated) result = {}
    else error = { code: -32000, message: 'fixture refuses credentials' }
  } else if (!authenticated) error = { code: -32000, message: 'authentication required' }
  else if (message.method === 'session/new')
    result = { sessionId: 'probe', configOptions: options(), models: {currentModelId: model} }
  else if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'model') model = message.params.value
    else thinking = message.params.value
    result = {configOptions: options()}
  } else error = { code: -32601 }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
    ...(error ? {error} : {result}) }) + '\\n')
})
`

function record(): HarnessSession {
  return {
    id: 'probe',
    combination: 'fixture',
    harnessRef: 'kimi-code',
    modelRef: { provider: 'our-free-model', model: 'moonshotai/kimi-k3' },
    cwd: tmpdir(),
    origin: { kind: 'dsh', sessionId: 'native' },
    sandbox: 'workspace',
    acpSessionId: '',
    title: 'probe',
    createdAt: '',
    updatedAt: '',
    turns: [],
  }
}

async function withAuthenticatedFixture(
  test: (input: {
    session: HarnessSession
    launch: Parameters<typeof probeHarnessReasoning>[2]
    methods: string
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'reasoning-auth-preflight-'))
  const program = join(root, 'agent.mjs')
  const methods = join(root, 'methods')
  try {
    await writeFile(program, authenticatedFixture)
    await test({
      session: {
        ...record(),
        cwd: root,
        harnessRef: 'antigravity',
        modelRef: { provider: 'opl-gateway', model: 'gemini::gemini-3.8-flash' },
        sandbox: 'full-access',
      },
      launch: {
        home: root,
        command: process.execPath,
        args: [program],
        env: { ...process.env, PROBE_METHODS: methods },
      },
      methods,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('external reasoning preflight', () => {
  it('keeps only offered values instead of a generic high/max ladder', () => {
    expect(
      readHarnessReasoning(record(), [
        { id: 'thinking', options: [{ value: 'off' }, { value: 'on' }] },
      ]),
    ).toEqual([
      { id: 'off', name: 'off' },
      { id: 'on', name: 'on' },
    ])
  })
  it('does not reflect arbitrary CLI labels or duplicate values', () => {
    expect(
      readHarnessReasoning(record(), [
        { id: 'thinking', options: [{ value: 'high', name: 'private data' }, { value: 'high' }] },
      ]),
    ).toEqual([{ id: 'high', name: 'high' }])
  })
  it('distinguishes absent advertisements from a model with no control', () => {
    expect(readHarnessReasoning(record(), undefined)).toBeUndefined()
    expect(readHarnessReasoning(record(), [{ id: 'model', options: [] }])).toEqual([])
    expect(
      readHarnessReasoning(record(), [{ id: 'thinking', options: [{ value: null }] }]),
    ).toBeUndefined()
  })
  it('reads the camel-case MiniMax effort option', () => {
    expect(
      readHarnessReasoning(record(), [{ id: 'thinkingEffort', options: [{ value: 'max' }] }]),
    ).toEqual([{ id: 'max', name: 'max' }])
  })
  it('offers M3 thinking variants only when the CLI advertises them', () => {
    const m3 = {
      ...record(),
      harnessRef: 'minimax-code',
      modelRef: { provider: 'minimax-official', model: 'MiniMax-M3' },
    }
    const { spec } = minimaxReasoning(m3.modelRef)!
    expect(
      readHarnessReasoning(m3, [
        { id: 'model', options: [{ value: minimaxModelValue(spec, 'off') }] },
      ]),
    ).toEqual([{ id: 'off', name: 'off' }])
  })
  it('authenticates before opening a session and accepts only the configured model readback', async () => {
    await withAuthenticatedFixture(async ({ session, launch, methods }) => {
      expect(await probeHarnessReasoning(antigravityAdapter, session, launch)).toEqual({
        status: 'known',
        efforts: ['low', 'medium', 'high'].map((id) => ({ id, name: id })),
      })
      expect(await readFile(methods, 'utf8')).toBe(
        'initialize\nauthenticate\nsession/new\nsession/set_config_option\nsession/set_config_option\n',
      )
      expect(session.turns).toEqual([])
    })
  }, 20000)
  it('does not allocate a session or send a prompt after authentication fails', async () => {
    await withAuthenticatedFixture(async ({ session, launch, methods }) => {
      await expect(
        probeHarnessReasoning(antigravityAdapter, session, {
          ...launch,
          env: { ...launch.env, PROBE_DENY_AUTH: '1' },
        }),
      ).rejects.toThrow('认证失败')
      expect(await readFile(methods, 'utf8')).toBe('initialize\nauthenticate\n')
      expect(session.acpSessionId).toBe('')
    })
  }, 20000)
  it.each(['other-model', undefined])(
    'refuses a configured model that is wrong or unconfirmed: %s',
    async (modelId) => {
      await withAuthenticatedFixture(async ({ session, launch, methods }) => {
        const adapter: HarnessAdapter = {
          ...antigravityAdapter,
          configureSession: async (acp, record, snapshot) => {
            const result = await antigravityAdapter.configureSession!(acp, record, snapshot)
            return { configOptions: result?.configOptions, ...(modelId ? { modelId } : {}) }
          },
        }
        await expect(probeHarnessReasoning(adapter, session, launch)).rejects.toThrow('模型回读')
        expect(await readFile(methods, 'utf8')).not.toContain('session/prompt')
      })
    },
    20000,
  )
  it('configures and reads a real ACP child without sending a prompt or attaching tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reasoning-preflight-'))
    const methods = join(root, 'methods')
    const adapter = {
      configureSession: async (acp, _record, snapshot) =>
        acp.request('session/set_config_option', {
          sessionId: snapshot.session.sessionId,
          configId: 'model',
          value: 'fixture',
        }),
      verifySession: (_record, snapshot) => expect(snapshot.configOptions).toHaveLength(2),
    } as HarnessAdapter
    try {
      const session = { ...record(), cwd: root }
      const result = await probeHarnessReasoning(adapter, session, {
        home: root,
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/reasoning-preflight.mjs', import.meta.url))],
        env: { ...process.env, PROBE_METHODS: methods },
      })
      expect(result.status).toBe('known')
      expect(result.efforts.map((effort) => effort.id)).toEqual(['off', 'on'])
      expect(await readFile(methods, 'utf8')).toBe(
        'initialize\nsession/new\nsession/set_config_option\n',
      )
      expect(session).not.toHaveProperty('nativeSessionId')
      expect(session.turns).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20000)
})
