/**
 * Test-only harness that drives the real compiled bridge through the suite's own ACP
 * transport, against the StepCode RPC stub.
 *
 * The bridge is bundled with the repository's esbuild, which is exactly how the
 * packager will build it (`step-bridge.ts` → `package/lib/step-bridge.mjs`). Bundling
 * here rather than importing the TypeScript module keeps the test honest: the process
 * under test is a separate Node program speaking ACP over stdio, not a same-process
 * function call.
 *
 * Synchronisation is by awaited protocol traffic only. Nothing polls on a timer or
 * sleeps to guess whether the agent caught up.
 */
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpProcess } from '../../../../src/execution/host/acp.ts'
import { STEP_CREDENTIAL_ENV } from '../../../../src/execution/host/adapters/step/step-config.ts'

const STUB = fileURLToPath(new URL('./stub-step-rpc.mjs', import.meta.url))
const BRIDGE_SOURCE = fileURLToPath(
  new URL('../../../../src/execution/host/adapters/step/step-bridge.ts', import.meta.url),
)

/** Root for every temporary artefact these tests create. Owned by this task. */
const BASE = process.env.OPL_STEP_TEST_ROOT ?? tmpdir()
mkdirSync(BASE, { recursive: true })
const ROOT = mkdtempSync(join(BASE, 'opl-step-tests-'))

let bridgePath = ''
const cleanups: string[] = []

/** Bundle the bridge once per run and return its absolute path. */
export async function stepBridgePath(): Promise<string> {
  if (bridgePath) return bridgePath
  await mkdir(ROOT, { recursive: true })
  const out = join(ROOT, 'step-bridge.mjs')
  const result = await build({
    entryPoints: [BRIDGE_SOURCE],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    write: false,
  })
  for (const file of result.outputFiles) await writeFile(file.path, file.contents)
  bridgePath = out
  return out
}

/**
 * Remove everything these tests created.
 *
 * Best effort by design: a bridge that was force-disposed can leave the official child
 * process holding a session file for a moment after the test ends, and Windows refuses
 * to delete a file with an open handle. Everything lives under this task's own temporary
 * root, so leaving a directory behind is harmless — failing the suite over it is not.
 */
/** Path of the last bridge diagnostic sink, for a failing test to read. */
export function stepBridgeDiagnostics(): string {
  return join(ROOT, `bridge-${Math.max(0, cleanups.length - 1)}.log`)
}

export function stepTestCleanup(): void {
  // `OPL_STEP_KEEP_TMP=1` preserves the run's temporary tree, which is how a bridge
  // diagnostic written during a failing test can still be read afterwards.
  if (process.env.OPL_STEP_KEEP_TMP === '1') return
  for (const path of cleanups.splice(0)) removeBestEffort(path)
  removeBestEffort(ROOT)
}

function removeBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // Retried already; the leftover is inside this task's temporary root.
  }
}

/** Create an isolated temp directory whose name mixes non-ASCII text and a space. */
export function stepTempDir(prefix = 'opl-step-'): string {
  // The root is created here rather than by a caller hook, so a spec that only needs a
  // temp directory does not depend on another spec's setup having run first.
  mkdirSync(ROOT, { recursive: true })
  const dir = mkdtempSync(join(ROOT.replace(/\/$/, ''), prefix))
  cleanups.push(dir)
  return dir
}

export interface StepAgentOptions {
  /** Working directory for the child. Defaults to a CJK-and-space directory. */
  cwd: string
  /** Environment handed to the bridge, matching `prepareStepLaunch`'s contract. */
  env: Record<string, string>
  /** Extra environment for the RPC stub, for negative tests. */
  stubEnv?: Record<string, string>
  /** Forward real bridge notifications to a Host owner under test. */
  onUpdate?(value: unknown): void
}

export interface StepAgent {
  acp: AcpProcess
  updates: unknown[]
  /**
   * Permission requests the bridge raised for the host to authorize.
   *
   * `session/request_permission` is an ACP *request*, so the transport routes it to the
   * permission callback rather than to the notification stream. A test that wants to see
   * a relayed approval must read it here.
   */
  permissions(): unknown[]
  /** Every `session/update` payload received so far. */
  all(): unknown[]
  /** Resolve once a notification carrying `text` has arrived. No polling, no sleeps. */
  waitForText(text: string): Promise<void>
  /** Resolve once a tool_call update with `status` has arrived. */
  waitForToolStatus(toolCallId: string, status: string): Promise<void>
  exited: Promise<void>
  dispose(): Promise<void>
}

/**
 * Start the bridge over the real ACP transport.
 *
 * Synchronisation is by request id and awaited notifications; the returned helpers
 * resolve on the matching frame instead of on a timer.
 */
export async function startStepAgent(options: StepAgentOptions): Promise<StepAgent> {
  const updates: unknown[] = []
  const permissions: unknown[] = []
  const textWaiters: { text: string; resolve: () => void }[] = []
  const toolWaiters: { id: string; status: string; resolve: () => void }[] = []
  let resolveExit!: () => void
  const exited = new Promise<void>((done) => {
    resolveExit = done
  })
  const bridge = await stepBridgePath()
  // Diagnostic sink inside the suite-owned temp root: the host's ACP transport drains this
  // process's stderr, so a failure is otherwise invisible to the test that owns it.
  const diagnostics = join(ROOT, `bridge-${cleanups.length}.log`)
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    ...(options.stubEnv ?? {}),
    OPL_STEP_DIAGNOSTICS: '1',
    OPL_STEP_DIAGNOSTICS_FILE: diagnostics,
  }
  const acp = new AcpProcess(
    process.execPath,
    [bridge],
    options.cwd,
    env,
    (value) => {
      updates.push(value)
      options.onUpdate?.(value)
      for (const waiter of textWaiters.splice(0))
        if (JSON.stringify(value).includes(waiter.text)) waiter.resolve()
      for (const waiter of toolWaiters.splice(0))
        if (
          JSON.stringify(value).includes(waiter.id) &&
          JSON.stringify(value).includes(`"${waiter.status}"`)
        )
          waiter.resolve()
    },
    (id, params) => {
      permissions.push({ id, params })
      // No automatic decision: the test decides, or the request stays unanswered.
    },
    () => resolveExit(),
  )
  return {
    acp,
    updates,
    all: () => updates,
    permissions: () => permissions,
    waitForText(text) {
      const seen = updates.find((value) => JSON.stringify(value).includes(text))
      if (seen) return Promise.resolve()
      return new Promise<void>((resolve) => textWaiters.push({ text, resolve }))
    },
    waitForToolStatus(id, status) {
      return new Promise<void>((resolve) => toolWaiters.push({ id, status, resolve }))
    },
    exited,
    async dispose() {
      await acp.dispose()
    },
  }
}

/**
 * Assert a launch environment claims no user-profile directory.
 *
 * `HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` are the signed-in user's own
 * directories. Isolation comes from the official StepCode variables instead, so a launch
 * that sets any of these is claiming storage it does not own.
 */
export function assertNoProfileDirs(env: Record<string, string>): void {
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME'])
    if (Object.hasOwn(env, key)) throw new Error(`launch environment must not override ${key}`)
}

/** The credential value tests place in the bridge environment. */
export const STEP_TEST_KEY = 'source-owned-key-not-a-real-secret'

/** Assert the launch environment carries the credential without leaking it elsewhere. */
export function credentialOf(env: Record<string, string>): string | undefined {
  return env[STEP_CREDENTIAL_ENV]
}
