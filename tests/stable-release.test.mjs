import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import YAML from 'yaml'
import { assertQualification } from '../scripts/publish-stable-release.mjs'

const artifact = {
  sourceCommit: 'a'.repeat(40),
  sourceTreeSha256: 'b'.repeat(64),
  enhancementVersion: '0.2.19',
  suiteSha256: 'c'.repeat(64),
  sha256: 'd'.repeat(64),
}
const feed = {
  url: 'https://download.deepseek.com/feed.yml',
  version: '0.2.0-rc.2',
  path: 'https://download.deepseek.com/desktop.exe',
  sha512: 'a'.repeat(86) + '==',
}
const manifest = {
  official: {
    version: feed.version,
    feeds: { 'mac-arm64': feed, 'win-x64': { ...feed } },
  },
}
function evidence(platform = 'darwin') {
  return {
    schemaVersion: 1,
    status: 'passed',
    sourceDirty: false,
    platform,
    arch: platform === 'darwin' ? 'arm64' : 'x64',
    ...artifact,
    enhancementSha256: artifact.sha256,
    officialVersion: manifest.official.version,
    officialIdentity: {
      signatureVerified: true,
      bundleId: 'com.deepseek.dsh',
      teamId: 'NAN929V4UM',
      publisher: 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.',
    },
    checks: {
      isolatedInstallation: true,
      officialUnmodified: true,
      downloadIntegrity: { sha512: true },
      client: { settings: true },
      runtime: {
        tools: true,
        officialCapabilities: {
          officialVersion: manifest.official.version,
          agentTeams: { owner: 'official', nativeChild: true, modelFacingTools: true },
          autoReview: {
            owner: 'official',
            mounted: true,
            defaultEnabled: false,
            selectablePreset: 'auto',
            defaultSelectable: false,
          },
          agentPresets: { owner: 'official' },
          oneShotProviders: [
            '@deepseek-ai/dsh-subagent-codex',
            '@deepseek-ai/dsh-subagent-claude-code',
          ].map((name) => ({
            package: name,
            owner: 'official',
            version: manifest.official.version,
          })),
        },
      },
      restart: { selections: true },
    },
  }
}

test('release requires both real platform identities and matching shipped bytes', () => {
  assertQualification(evidence(), artifact, manifest, 'darwin', 'arm64')
  assertQualification(evidence('win32'), artifact, manifest, 'win32', 'x64')
})

test('release requires official capability ownership and a completed native Team child', () => {
  for (const patch of [
    { officialVersion: '0.2.1-rc.5' },
    { agentTeams: { owner: 'official', modelFacingTools: true, nativeChild: false } },
    { autoReview: { owner: 'opl', mounted: true } },
    {
      autoReview: {
        owner: 'official',
        mounted: true,
        defaultEnabled: false,
        selectablePreset: 'auto',
        defaultSelectable: true,
      },
    },
    {
      autoReview: { ...evidence().checks.runtime.officialCapabilities.autoReview, defaultEnabled: true },
    },
    { oneShotProviders: [] },
  ]) {
    const candidate = evidence()
    Object.assign(candidate.checks.runtime.officialCapabilities, patch)
    assert.throws(
      () => assertQualification(candidate, artifact, manifest, 'darwin', 'arm64'),
      /official capability/,
    )
  }
})

test('release rejects stale qualifications, dirty source and failed or wrong-platform runs', () => {
  for (const patch of [
    { sourceCommit: 'e'.repeat(40) },
    { sourceTreeSha256: 'e'.repeat(64) },
    { enhancementVersion: '0.2.18' },
    { suiteSha256: 'e'.repeat(64) },
    { enhancementSha256: 'e'.repeat(64) },
    { officialVersion: '0.2.0' },
    { sourceDirty: true },
    { sourceDirty: undefined },
    { status: 'failed' },
    { platform: 'win32' },
    { arch: 'x64' },
  ])
    assert.throws(() =>
      assertQualification({ ...evidence(), ...patch }, artifact, manifest, 'darwin', 'arm64'),
    )
})

test('release rejects missing signature, wrong official identity and skipped checks', () => {
  for (const patch of [
    { officialIdentity: { signatureVerified: false } },
    { officialIdentity: { ...evidence().officialIdentity, teamId: 'someone-else' } },
    { checks: { ...evidence().checks, client: {} } },
    { checks: { ...evidence().checks, runtime: null } },
    { checks: { ...evidence().checks, restart: [] } },
    { checks: { ...evidence().checks, officialUnmodified: false } },
    { checks: { ...evidence().checks, downloadIntegrity: {} } },
  ])
    assert.throws(() =>
      assertQualification({ ...evidence(), ...patch }, artifact, manifest, 'darwin', 'arm64'),
    )
  const windows = evidence('win32')
  windows.officialIdentity.publisher = 'someone-else'
  assert.throws(() => assertQualification(windows, artifact, manifest, 'win32', 'x64'))
})

test('stable workflow makes Windows qualification and evidence mandatory', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/stable-release.yml', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(workflow, /continue-on-error/)
  const jobs = YAML.parse(workflow).jobs
  assert.deepEqual(jobs.publish.needs, ['prepare', 'package', 'qualify'])
  const upload = jobs.qualify.steps.find(
    (step) => step.with?.name === 'release-qualification-${{ matrix.os }}',
  )
  assert.equal(
    jobs.qualify.steps.find((step) => step.id === 'qualification')?.['continue-on-error'],
    undefined,
  )
  assert.equal(
    upload.if,
    "${{ always() && (steps.qualification.outcome == 'success' || steps.qualification.outcome == 'failure') }}",
  )
  assert.equal(
    upload.with['if-no-files-found'],
    "${{ steps.qualification.outcome == 'success' && 'error' || 'warn' }}",
  )
  assert.match(
    jobs.qualify.steps.find((step) => step.name === 'Verify shared SuperAgent tests on Windows')
      .run,
    /--maxWorkers=1/,
  )
  assert.match(
    workflow,
    /name: release-qualification-windows-latest[\s\S]*?path: dist\/evidence\/windows-latest/,
  )
  const publisher = await readFile(
    new URL('../scripts/publish-stable-release.mjs', import.meta.url),
    'utf8',
  )
  assert.match(
    publisher,
    /const windowsEvidence = await readQualification\(root, 'windows-latest'\)/,
  )
  assert.doesNotMatch(publisher, /status: 'unavailable'|status: 'failed'/)
  assert.match(publisher, /OPL_PREPARED_OFFICIAL_WINDOWS_VERSION/)
})

test('compatibility retains qualification failures without secondary missing-artifact errors', async () => {
  const source = await readFile(
    new URL('../.github/workflows/official-compatibility.yml', import.meta.url),
    'utf8',
  )
  const steps = YAML.parse(source).jobs['official-desktop'].steps
  assert.equal(steps.find((step) => step.id === 'qualification')?.['continue-on-error'], undefined)
  const upload = steps.find((step) => step.with?.name === 'official-qualification-${{ matrix.os }}')
  assert.equal(
    upload.if,
    "${{ always() && (steps.qualification.outcome == 'success' || steps.qualification.outcome == 'failure') }}",
  )
  assert.equal(
    upload.with['if-no-files-found'],
    "${{ steps.qualification.outcome == 'success' && 'error' || 'warn' }}",
  )
})
