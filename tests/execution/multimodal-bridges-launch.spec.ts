import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AcpProcess } from '../../src/execution/host/acp.ts'
import { grokAdapter } from '../../src/execution/host/adapters/grok.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'

const executable = vi.hoisted(() => ({ path: '' }))
vi.mock('../../src/execution/host/harness-registry.ts', async (original) => ({
  ...(await original<typeof import('../../src/execution/host/harness-registry.ts')>()),
  executablePath: async () => executable.path,
}))
vi.mock('../../src/execution/host/adapters/grok-bash.ts', () => ({
  grokBashEnvironment: async (env: NodeJS.ProcessEnv) => env,
}))

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

it.each([true, false, undefined])(
  'Grok launches its resolved executable without PATH and retains source image support (%s)',
  async (imageInput) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'opl-grok-resolved-')))
    cleanups.push(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
    executable.path = process.execPath
    const source = {
      resolve: vi.fn(async () => ({
        apiKey: 'keyless-launch-fixture',
        baseURL: 'https://fixture.example.test/v1',
        model: 'grok-4.7',
        protocol: 'responses',
        ...(imageInput === undefined ? {} : { imageInput }),
      })),
    }
    const launch = await grokAdapter.prepare!(
      {} as never,
      {
        sandbox: 'full-access',
        cwd,
        modelRef: { provider: 'opl-gateway', model: 'grok::grok-4.7' },
      } as HarnessSession,
      {
        home: cwd,
        grokCommand: 'grok-not-on-the-child-path',
        nativeBridgePath: '',
        prefix: [resolve('tests/execution/multimodal-bridges/wire-agent.mjs')],
        modelSources: source as never,
      },
    )
    expect(launch.command).toBe(process.execPath)
    expect(launch.promptImageSupport).toBe(imageInput === true)
    const acp = new AcpProcess(
      launch.command,
      launch.args,
      cwd,
      {
        ...launch.env,
        PATH: '',
        OPL_MULTIMODAL_FIXTURE_MODE: 'acp',
        OPL_MULTIMODAL_WIRE_LOG: join(cwd, 'wire.jsonl'),
      },
      () => {},
      () => {},
      () => {},
    )
    cleanups.push(() => acp.dispose())
    await expect(acp.request('initialize', { protocolVersion: 1 })).resolves.toMatchObject({
      protocolVersion: 1,
    })
  },
)
