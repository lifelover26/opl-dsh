/**
 * Assertions against the REAL official Kimi Code CLI.
 *
 * These launch the published `@moonshot-ai/kimi-code` binary with the OFM route in its
 * documented environment and a controlled loopback provider, then assert what the binary
 * itself did: which model id it advertised, what it actually put on the wire, and whether
 * its own `Bash` tool executed on disk.
 *
 * The loopback provider is keyless and synthetic. That makes this wire and
 * tool-execution evidence — it is NOT evidence of OFM model quality, which the suite
 * owner must accept separately.
 *
 * Set `OPL_KIMI_PROBE_BINARY` to the published `dist/main.mjs` to enable these. The
 * binary must already have its runtime dependencies; this file installs nothing.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import { KIMI_ENV_MODEL_ALIAS } from '../../../src/execution/host/adapters/kimi/kimi-models.ts'

const PROBE = fileURLToPath(new URL('./fixtures/real-binary-probe.mjs', import.meta.url))
const BIN = process.env.OPL_KIMI_PROBE_BINARY ?? ''
const WIRE_MODEL = 'moonshotai/kimi-k3'
const available = BIN.length > 0 && existsSync(BIN)

interface Wire {
  url: string
  model: string
  stream: boolean
  anthropicVersion: string
  toolNames: string[]
  sawToolResult: number
  toolResultPreview: string | null
}

interface Report {
  agentInfo?: { name: string; version: string }
  sessionNewError?: { code: number; message: string }
  modelOption?: { currentValue: string; values: string[] }
  modeOption?: { currentValue: string; values: string[] }
  modeAfterSet?: string
  modelAfterSet?: string
  prompt?: { ok: boolean; stopReason?: string }
  turnActiveBeforeCancel?: boolean
  providerRequestAborted?: boolean
  toolWroteFile?: boolean
  fileContent?: string
  loaded?: { ok: boolean; model?: string; mode?: string }
  closed?: { ok: boolean }
  wire?: Wire[]
  teardown?: {
    childExit?: { code: number | null; signal: string | null } | null
    httpClose?: string
    clientSawRequestClose?: boolean
  }
  fatal?: unknown
}

/** Run the probe and return its report, correlated by process exit rather than a timer. */
function runProbe(
  mode: string,
  behaviour: '' | 'omit' | 'hold' | 'reject' | 'recover',
  label: string,
): Report {
  const root = mkdtempSync(join(tmpdir(), `opl-kimi-real-${label}-`))
  const out = join(root, 'report.json')
  const result = spawnSync(
    process.execPath,
    [PROBE, BIN, out, join(root, 'home'), resolveGitBashPath(), WIRE_MODEL, mode, behaviour],
    { encoding: 'utf8', windowsHide: true, timeout: 240000 },
  )
  try {
    if (result.status !== 0 || !existsSync(out))
      throw new Error(
        `probe ${label} failed (exit ${result.status}): ${result.stderr?.slice(0, 400)}`,
      )
    return JSON.parse(readFileSync(out, 'utf8')) as Report
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(!available)(
  'official Kimi Code CLI with the OFM route (real binary)',
  () => {
    it('honors the provider refusal to retry a failed request', () => {
      const report = runProbe('yolo', 'reject', 'retry')
      expect(report.wire).toHaveLength(1)
      expect(report.toolWroteFile).not.toBe(true)
    })
    it('uses the official CLI recovery after a transient provider failure', () => {
      const report = runProbe('yolo', 'recover', 'recover')
      expect(report.wire?.length).toBeGreaterThanOrEqual(3)
      expect(report.prompt?.ok).toBe(true)
      expect(report.toolWroteFile).toBe(true)
    })
    it('fails closed without the route, which is what makes the route load-bearing', () => {
      const report = runProbe('yolo', 'omit', 'noroute')
      // The official AUTH_REQUIRED code: no Moonshot account and no route means no session.
      expect(report.sessionNewError?.code).toBe(-32000)
      expect(report.wire ?? []).toHaveLength(0)
    })

    it('adopts the source route and advertises its env alias, not the wire model', () => {
      const report = runProbe('yolo', '', 'route')
      expect(report.agentInfo).toEqual({ name: 'Kimi Code CLI', version: '2.1.1' })
      expect(report.modelOption?.currentValue).toBe(KIMI_ENV_MODEL_ALIAS)
      expect(report.modelOption?.values).toEqual([KIMI_ENV_MODEL_ALIAS])
      // The alias and the wire model are distinct identifiers, and the suite pins the alias.
      expect(KIMI_ENV_MODEL_ALIAS).not.toBe(WIRE_MODEL)
    })

    it('really sends the route on the wire, with the anthropic protocol', () => {
      const report = runProbe('yolo', '', 'wire')
      const first = report.wire?.[0]
      expect(first?.url).toContain('/v1/messages')
      // The model that reached the provider is the source's model, proving the route was used.
      expect(first?.model).toBe(WIRE_MODEL)
      // `messages` is carried to the CLI as its anthropic provider type.
      expect(first?.anthropicVersion).toBe('2023-06-01')
      expect(first?.stream).toBe(true)
    })

    it('executes its own shell tool on disk in a non-ASCII, space-containing directory', () => {
      const report = runProbe('yolo', '', 'tool')
      expect(report.toolWroteFile).toBe(true)
      // The tool's own write round-tripped as UTF-8 through a CJK path that contains a space.
      expect(report.fileContent).toContain('来自 kimi')
      // The real binary offered its own Bash tool and drove it on the provider's request.
      expect(report.wire?.[0]?.toolNames).toContain('Bash')
      // The follow-up request carries the tool result, so the tool really ran.
      expect(report.wire?.[1]?.sawToolResult).toBe(1)
      expect(report.prompt?.ok).toBe(true)
    })

    it('returns real git output from that tool, committing nothing', () => {
      const report = runProbe('yolo', '', 'git')
      const result = report.wire?.[1]?.toolResultPreview ?? ''
      // The tool's own `pwd` is the non-ASCII directory that contains a space, so the shell
      // ran where the session said it did.
      expect(result).toContain('目录 work')
      expect(result).toContain('来自 kimi')
      // A real `git --version` ran inside that directory.
      expect(result).toMatch(/git version 2\./)
      // Nothing was committed: the directory is not a repository.
      expect(result).toContain('not a git repository')
    })

    it('supports new, cancel, load, and close on the real session', () => {
      const report = runProbe('yolo', '', 'lifecycle')
      expect(report.modeOption?.values).toEqual(['default', 'plan', 'auto', 'yolo'])
      expect(report.modeAfterSet).toBe('yolo')
      // Setting the mode must not disturb the pinned model.
      expect(report.modelAfterSet).toBe(KIMI_ENV_MODEL_ALIAS)
      expect(report.loaded?.ok).toBe(true)
      expect(report.closed?.ok).toBe(true)
    })

    it('does not execute the shell tool in plan mode', () => {
      const report = runProbe('plan', '', 'plan')
      expect(report.modeAfterSet).toBe('plan')
      // Measured rather than assumed: with no one able to answer an approval request, the
      // tool never runs and nothing is written.
      expect(report.toolWroteFile).toBe(false)
    })

    it('cancels a turn that is genuinely still running, not one already finished', () => {
      // The provider never answers, so the turn stays open with a live model request.
      const report = runProbe('yolo', 'hold', 'cancel')
      expect(report.turnActiveBeforeCancel).toBe(true)
      expect(report.prompt?.stopReason).toBe('cancelled')
      // The cancellation reached the in-flight provider request and no tool ran.
      expect(report.providerRequestAborted).toBe(true)
      expect(report.toolWroteFile).toBe(false)
    })

    it('tears down the child and the controlled server, and keeps results when a run fails', () => {
      const report = runProbe('yolo', '', 'teardown')
      // The child is waited on, not just signalled.
      expect(report.teardown?.childExit).not.toBeUndefined()
      expect(report.teardown?.httpClose).toBe('closed')
      // A record exists regardless of outcome, which is what makes a failing run evidence.
      expect(report.fatal).toBeUndefined()
    })
  },
  900000,
)
