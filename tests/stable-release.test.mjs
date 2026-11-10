import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertQualification } from '../scripts/publish-stable-release.mjs'

const artifact = {
  sourceCommit: 'a'.repeat(40),
  sourceTreeSha256: 'b'.repeat(64),
  enhancementVersion: '0.2.19',
  suiteSha256: 'c'.repeat(64),
  sha256: 'd'.repeat(64),
}
const manifest = { official: { version: '0.2.0-rc.2' } }
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
        selectablePreset: 'auto',
        defaultSelectable: true,
      },
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
