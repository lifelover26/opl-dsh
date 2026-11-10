import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReleaseManifest } from '../installer/release-manifest.mjs'
import { verifyPayload } from './qualification-support.mjs'
import { renderReleaseNotes } from './release-notes.mjs'

const repository = 'gaofeng21cn/opl-dsh'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const command = (program, args) =>
  execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const api = (path) => JSON.parse(command('gh', ['api', path]))
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Both runners must have qualified the same clean source and exact shipped payload. */
export function assertQualification(evidence, artifact, manifest, platform, arch) {
  if (
    evidence.schemaVersion !== 1 ||
    evidence.status !== 'passed' ||
    evidence.sourceDirty !== false ||
    evidence.platform !== platform ||
    evidence.arch !== arch
  )
    throw Error(`Invalid ${platform} qualification status or executor`)
  for (const field of ['sourceCommit', 'sourceTreeSha256', 'enhancementVersion', 'suiteSha256'])
    if (typeof artifact[field] !== 'string' || evidence[field] !== artifact[field])
      throw Error(`${platform} qualification does not match candidate ${field}`)
  if (
    evidence.enhancementSha256 !== artifact.sha256 ||
    evidence.officialVersion !== manifest.official.version ||
    evidence.officialIdentity?.signatureVerified !== true
  )
    throw Error(`${platform} qualification has a different payload, official version or identity`)
  if (
    platform === 'darwin' &&
    (evidence.officialIdentity.bundleId !== 'com.deepseek.dsh' ||
      evidence.officialIdentity.teamId !== 'NAN929V4UM')
  )
    throw Error('Unexpected macOS official identity')
  if (
    platform === 'win32' &&
    evidence.officialIdentity.publisher !== 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.'
  )
    throw Error('Unexpected Windows official publisher')
  const checks = evidence.checks
  if (
    checks?.isolatedInstallation !== true ||
    checks?.officialUnmodified !== true ||
    checks?.downloadIntegrity?.sha512 !== true ||
    !['client', 'runtime', 'restart'].every(
      (key) => record(checks[key]) && Object.keys(checks[key]).length > 0,
    )
  )
    throw Error(`${platform} qualification is missing required checks`)
  const capabilities = checks.runtime.officialCapabilities
  if (
    capabilities?.officialVersion !== evidence.officialVersion ||
    capabilities.agentTeams?.owner !== 'official' ||
    capabilities.agentTeams?.nativeChild !== true ||
    capabilities.agentTeams?.modelFacingTools !== true ||
    capabilities.autoReview?.owner !== 'official' ||
    capabilities.autoReview?.mounted !== true ||
    capabilities.autoReview?.selectablePreset !== 'auto' ||
    capabilities.autoReview?.defaultSelectable !== false ||
    capabilities.agentPresets?.owner !== 'official' ||
    !['@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-subagent-claude-code'].every((name) =>
      capabilities.oneShotProviders?.some(
        (provider) =>
          provider.package === name &&
          provider.owner === 'official' &&
          provider.version === evidence.officialVersion,
      ),
    )
  )
    throw Error(
      `${platform} qualification is missing official capability ownership or real Team execution`,
    )
  return evidence
}

export async function publishStableRelease(root) {
  if (process.env.GITHUB_REPOSITORY !== repository)
    throw Error('This publisher only writes to gaofeng21cn/opl-dsh')
  const dist = join(root, 'dist')
  const audit = join(dist, 'release-audit')
  await mkdir(audit, { recursive: true })
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  const tag = `opl-dsh-v${version}`
  const selectedTag =
    process.env.OPL_RELEASE_TAG ?? process.env.GITHUB_REF?.replace(/^refs\/tags\//, '')
  if (!/^\d+\.\d+\.\d+$/.test(version) || selectedTag !== tag)
    throw Error('Publishing requires the canonical stable tag')
  const sourceCommit = command('git', ['rev-parse', 'HEAD'])
  if (command('git', ['rev-parse', `${tag}^{commit}`]) !== sourceCommit)
    throw Error('Release tag does not match the frozen source')
  if (command('git', ['status', '--porcelain'])) throw Error('Candidate source is dirty')
  const manifestFile = join(dist, 'release-manifest.json')
  const manifestBytes = await readFile(manifestFile)
  const manifest = validateReleaseManifest(JSON.parse(manifestBytes), {
    tagName: tag,
    assetName: 'OPL-DSH-Enhancements.zip',
  })
  const archive = await readFile(join(dist, manifest.enhancement.asset))
  if (
    manifest.sourceCommit !== sourceCommit ||
    manifest.releaseVersion !== version ||
    manifest.enhancement.sha256 !== `sha256:${hash(archive)}` ||
    manifest.enhancement.size !== archive.length
  )
    throw Error('Release archive or source does not match its manifest')
  const payload = join(dist, 'OPL DSH 一键安装')
  command('python3', ['-m', 'zipfile', '-e', join(dist, manifest.enhancement.asset), payload])
  const artifact = await verifyPayload(payload)
  if (
    artifact.sourceDirty !== false ||
    artifact.sourceCommit !== sourceCommit ||
    artifact.sourceTreeSha256 !== manifest.sourceTreeSha256 ||
    artifact.enhancementVersion !== version ||
    artifact.officialVersion !== manifest.official.version
  )
    throw Error('Shipped payload provenance differs from the frozen release candidate')
  const platforms = {}
  for (const [runner, platform, arch] of [
    ['macos-15', 'darwin', 'arm64'],
    ['windows-latest', 'win32', 'x64'],
  ]) {
    const evidence = JSON.parse(
      await readFile(join(dist, 'evidence', runner, 'official-qualification.json'), 'utf8'),
    )
    platforms[platform] = assertQualification(evidence, artifact, manifest, platform, arch)
  }
  // Re-read both official feeds immediately before publishing. The same inputs
  // must produce an identical manifest; do not substitute a handwritten baseline.
  await writeFile(join(dist, 'artifact.json'), JSON.stringify(artifact))
  command(process.execPath, [join(root, 'scripts/create-release-manifest.mjs')])
  if (!manifestBytes.equals(await readFile(manifestFile)))
    throw Error('The official feeds or release manifest changed after qualification')
  const qualification = {
    schemaVersion: 1,
    status: 'passed',
    sourceCommit,
    sourceTreeSha256: artifact.sourceTreeSha256,
    sourceDirty: false,
    officialVersion: artifact.officialVersion,
    enhancementVersion: version,
    enhancementSha256: artifact.sha256,
    suiteSha256: artifact.suiteSha256,
    protocolProbe: 'local-fixture',
    platforms,
  }
  await writeFile(join(dist, manifest.qualification), JSON.stringify(qualification, null, 2) + '\n')
  const files = [
    manifest.enhancement.asset,
    'OPL-DSH-Installer-mac-arm64.dmg',
    'OPL-DSH-Installer-windows-x64.exe',
    'release-manifest.json',
    manifest.qualification,
  ]
  const sums = {}
  for (const file of files) {
    const bytes = await readFile(join(dist, file))
    if (!bytes.length) throw Error(`Empty release asset: ${file}`)
    sums[file] = hash(bytes)
  }
  await writeFile(
    join(dist, 'SHA256SUMS'),
    files.map((file) => `${sums[file]}  ${file}\n`).join(''),
  )
  files.push('SHA256SUMS')
  sums.SHA256SUMS = hash(await readFile(join(dist, 'SHA256SUMS')))
  const notesFile = join(dist, 'release-notes.md')
  const notes = renderReleaseNotes(
    await readFile(join(root, 'docs', `release-notes-${version}.md`), 'utf8'),
    { version, officialVersion: manifest.official.version, sourceCommit },
  )
  await writeFile(notesFile, notes)
  const previous = JSON.parse(
    command('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]),
  ).flat()
  await writeFile(join(audit, 'previous-releases.json'), JSON.stringify(previous, null, 2) + '\n')
  await writeFile(join(audit, 'tags.txt'), command('git', ['show-ref', '--tags']) + '\n')
  await writeFile(
    join(audit, 'official-upstream-releases.json'),
    JSON.stringify(api('repos/deepseek-ai/deepseek-harness/releases?per_page=3'), null, 2) + '\n',
  )
  const result = { version, tag, sourceCommit, published: false, checksums: sums }
  const save = () => writeFile(join(audit, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  await save()
  // Read before creating, including after an interrupted upload. Never overwrite
  // public assets with a rebuilt candidate whose bytes may differ.
  const existing = spawnSync('gh', ['api', `repos/${repository}/releases/tags/${tag}`], {
    encoding: 'utf8',
  })
  if (existing.status !== 0 && !/HTTP 404/.test(existing.stderr))
    throw Error('Cannot determine whether this release already exists')
  const release = existing.status === 0 && JSON.parse(existing.stdout)
  if (!release) {
    command('gh', [
      'release',
      'create',
      tag,
      ...files.map((file) => join(dist, file)),
      '--repo',
      repository,
      '--verify-tag',
      '--draft',
      '--title',
      `OPL DSH v${version}`,
      '--notes-file',
      notesFile,
    ])
  } else if (release.draft) {
    command('gh', [
      'release',
      'upload',
      tag,
      ...files.map((file) => join(dist, file)),
      '--repo',
      repository,
      '--clobber',
    ])
  }
  if (!release || release.draft)
    command('gh', [
      'release',
      'edit',
      tag,
      '--repo',
      repository,
      '--draft=false',
      '--prerelease=false',
      '--latest',
      '--title',
      `OPL DSH v${version}`,
      '--notes-file',
      notesFile,
    ])
  const published = api(`repos/${repository}/releases/tags/${tag}`)
  result.published = !published.draft
  result.url = published.html_url
  await save()
  if (
    published.draft ||
    published.prerelease ||
    published.name !== `OPL DSH v${version}` ||
    published.body !== notes ||
    JSON.stringify(published.assets.map((asset) => asset.name).sort()) !==
      JSON.stringify([...files].sort()) ||
    api(`repos/${repository}/releases/latest`).tag_name !== tag
  )
    throw Error('Public release metadata, notes, assets or Latest differ from the candidate')
  const latestUrl = command('curl', [
    '-fsSL',
    '--max-time',
    '60',
    `https://github.com/${repository}/releases/latest`,
    '-o',
    '/dev/null',
    '-w',
    '%{url_effective}',
  ])
  if (latestUrl !== published.html_url) throw Error('Public Latest URL points at a different tag')
  const downloads = join(dist, 'public-readback')
  await mkdir(downloads, { recursive: true })
  command('gh', ['release', 'download', tag, '--repo', repository, '--dir', downloads])
  for (const file of files)
    if (hash(await readFile(join(downloads, file))) !== sums[file])
      throw Error(`Public asset checksum mismatch: ${file}`)
  result.publicReadback = 'passed'
  await save()
  // Cask metadata is excluded from the product source hash. Push normally and
  // refuse to overwrite a main branch that moved during qualification.
  command('git', ['fetch', 'origin', 'main'])
  if (command('git', ['rev-parse', 'origin/main']) !== sourceCommit)
    throw Error('main moved during qualification; update the Cask separately')
  command('git', ['switch', '-c', `release-cask-${version}`, 'origin/main'])
  const caskFile = join(root, 'Casks/opl-dsh.rb')
  const cask = (await readFile(caskFile, 'utf8'))
    .replace(/version "[^"]+"/, `version "${version}"`)
    .replace(/sha256 "[^"]+"/, `sha256 "${sums[manifest.enhancement.asset]}"`)
  await writeFile(caskFile, cask)
  command('ruby', ['-c', caskFile])
  command('git', ['config', 'user.name', 'github-actions[bot]'])
  command('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  command('git', ['add', 'Casks/opl-dsh.rb'])
  command('git', ['commit', '-m', `chore: update Homebrew Cask to OPL DSH v${version}`])
  command('git', ['push', 'origin', 'HEAD:main'])
  command('git', ['fetch', 'origin', 'main'])
  const publicCask = command('git', ['show', 'origin/main:Casks/opl-dsh.rb'])
  if (!publicCask.includes(`version "${version}"`) || !publicCask.includes(sums[files[0]]))
    throw Error('Public Cask metadata differs from the release ZIP checksum')
  result.homebrew = 'passed'
  await save()
  result.historyRetention = 'preserved'
  result.status = 'complete'
  await save()
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await publishStableRelease(resolve(import.meta.dirname, '..'))
