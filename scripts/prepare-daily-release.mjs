/** Daily GitHub-owned release preparation; all packaging and qualification stay in the existing workflow. */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeDailyReleaseNotes } from './daily-release-notes.mjs'

const repository = 'gaofeng21cn/opl-dsh'
const productPaths = [
  'src',
  'installer',
  'build.mjs',
  'package.mjs',
  'package.json',
  'package-lock.json',
  'cordis.patch.yml',
  'install.sh',
  'install.ps1',
  'scripts/build-native-bridge.mjs',
  'scripts/build-superagent.mjs',
  'vendor/dsh-superagent/src',
  'vendor/dsh-superagent/cordis.patch.yml',
  'vendor/dsh-superagent/package.json',
  'vendor/dsh-superagent/tsdown.config.ts',
  'vendor/dsh-superagent/prompts',
  'vendor/dsh-superagent/skills',
  'vendor/dsh-superagent/locale',
]
const git = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
const stable = /^\d+\.\d+\.\d+$/
const compare = (a, b) => {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

/** Decide from public Latest and real product paths, excluding derived Cask and docs-only changes. */
export async function planDailyRelease(root, latest) {
  const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!stable.test(project.version)) throw Error('OPL version is not stable SemVer')
  if (git(root, ['status', '--porcelain'])) throw Error('Release preparation requires clean source')
  const currentTag = `opl-dsh-v${project.version}`
  if (latest) {
    const publishedVersion = latest.tag_name?.replace(/^opl-dsh-v/, '')
    if (
      latest.draft ||
      latest.prerelease ||
      !stable.test(publishedVersion) ||
      latest.tag_name !== `opl-dsh-v${publishedVersion}`
    )
      throw Error('Public Latest is not a canonical stable OPL DSH release')
    // Refuse a rewritten/divergent main rather than inferring which bytes were delivered.
    git(root, ['merge-base', '--is-ancestor', latest.tag_name, 'HEAD'])
    const changes = git(root, [
      'diff',
      '--name-only',
      latest.tag_name,
      'HEAD',
      '--',
      ...productPaths,
    ])
    if (!changes) return { action: 'skip', reason: '没有未发布的增强层改动' }
    if (compare(project.version, publishedVersion) <= 0) {
      const parts = publishedVersion.split('.').map(Number)
      parts[2]++
      return { action: 'prepare', version: parts.join('.'), baseline: latest.tag_name }
    }
  }
  const tagged = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${currentTag}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  })
  if (tagged.status === 0) {
    git(root, ['merge-base', '--is-ancestor', currentTag, 'HEAD'])
    const frozen = JSON.parse(git(root, ['show', `${currentTag}:package.json`]))
    if (frozen.version !== project.version)
      throw Error('Pending tag has a different package version')
    const productChanges = git(root, [
      'diff',
      '--name-only',
      currentTag,
      'HEAD',
      '--',
      ...productPaths,
    ])
    if (productChanges) {
      // A frozen tag keeps its original product bytes. Later product fixes need
      // a new identity; runner/docs-only repairs can still resume the old tag.
      const parts = project.version.split('.').map(Number)
      do {
        parts[2]++
      } while (
        spawnSync(
          'git',
          ['show-ref', '--verify', '--quiet', `refs/tags/opl-dsh-v${parts.join('.')}`],
          {
            cwd: root,
          },
        ).status === 0
      )
      return { action: 'prepare', version: parts.join('.'), baseline: latest?.tag_name }
    }
    return { action: 'resume', tag: currentTag, sourceCommit: tagged.stdout.trim() }
  }
  return { action: 'prepare', version: project.version, baseline: latest?.tag_name }
}

export async function prepareDailyRelease(root) {
  if (process.env.GITHUB_REPOSITORY !== repository) throw Error('Unexpected release repository')
  const ref = process.env.GITHUB_REF
  let candidate
  if (/^refs\/tags\/opl-dsh-v\d+\.\d+\.\d+$/.test(ref ?? '')) {
    const tag = ref.slice('refs/tags/'.length)
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
    if (tag !== `opl-dsh-v${version}`) throw Error('Tag differs from the package version')
    candidate = { action: 'resume', tag, sourceCommit: git(root, ['rev-parse', `${tag}^{commit}`]) }
  } else {
    if (ref !== 'refs/heads/main') throw Error('Daily preparation requires main')
    git(root, ['fetch', 'origin', 'main', '--tags'])
    if (git(root, ['rev-parse', 'HEAD']) !== git(root, ['rev-parse', 'origin/main']))
      throw Error('main moved; retry the next daily check from fresh main')
    const response = spawnSync('gh', ['api', `repos/${repository}/releases/latest`], {
      encoding: 'utf8',
    })
    if (response.status !== 0 && !/HTTP 404/.test(response.stderr))
      throw Error('Cannot read public Latest; no version or tag was written')
    const latest = response.status === 0 ? JSON.parse(response.stdout) : undefined
    candidate = await planDailyRelease(root, latest)
    if (candidate.action === 'prepare') {
      const changes = git(root, [
        'log',
        '--no-merges',
        `--format=- %s ([查看提交](https://github.com/${repository}/commit/%H))`,
        candidate.baseline ? `${candidate.baseline}..HEAD` : 'HEAD',
        '--',
        ...productPaths,
      ])
      const notesFile = join(root, 'docs', `release-notes-${candidate.version}.md`)
      // A maintainer's prepared notes remain authoritative.
      try {
        await readFile(notesFile)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const evidencePaths = [
          ...productPaths,
          'README.md',
          'docs',
          ':!package-lock.json',
          ':!src/generated',
          ':!docs/release-notes-*.md',
        ]
        const diff = spawnSync(
          'git',
          candidate.baseline
            ? ['diff', candidate.baseline, 'HEAD', '--', ...evidencePaths]
            : ['show', '--format=', 'HEAD', '--', ...evidencePaths],
          { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        )
        const result = await writeDailyReleaseNotes(
          {
            version: candidate.version,
            baseline: candidate.baseline ?? null,
            sourceCommit: git(root, ['rev-parse', 'HEAD']),
            commitsMarkdown: changes,
            commitDetails: git(root, [
              'log',
              '--no-merges',
              '--format=%h %s%n%b',
              candidate.baseline ? candidate.baseline + '..HEAD' : 'HEAD',
              '--',
              ...productPaths,
            ]),
            diff: diff.status === 0 ? diff.stdout : '',
            diffComplete: diff.status === 0,
          },
          {
            apiKey: process.env.OPL_RELEASE_NOTES_CODEX_API_KEY,
            copilotToken: process.env.GITHUB_TOKEN,
          },
        )
        await writeFile(notesFile, result.notes)
        console.log(
          JSON.stringify({
            releaseNotes: result.mode,
            model: result.model,
            policy: result.policy,
            reason: result.reason,
            attempts: result.attempts,
          }),
        )
      }
      for (const path of ['package.json', 'package-lock.json']) {
        const file = join(root, path)
        const value = JSON.parse(await readFile(file, 'utf8'))
        value.version = candidate.version
        if (value.packages?.['']) value.packages[''].version = candidate.version
        await writeFile(file, JSON.stringify(value, null, 2) + '\n')
      }
      git(root, ['config', 'user.name', 'github-actions[bot]'])
      git(root, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
      git(root, [
        'add',
        'package.json',
        'package-lock.json',
        `docs/release-notes-${candidate.version}.md`,
      ])
      if (git(root, ['diff', '--cached', '--name-only']))
        git(root, ['commit', '-m', `release: prepare OPL DSH v${candidate.version}`])
      candidate.tag = `opl-dsh-v${candidate.version}`
      git(root, ['tag', '-a', candidate.tag, '-m', `OPL DSH v${candidate.version}`])
      // Never force main or reuse a tag. The same run continues with these exact bytes:
      // tag pushes made with GITHUB_TOKEN intentionally do not trigger another workflow.
      git(root, ['push', '--atomic', 'origin', 'HEAD:main', `refs/tags/${candidate.tag}`])
      candidate.sourceCommit = git(root, ['rev-parse', 'HEAD'])
      const remote = git(root, ['ls-remote', 'origin', `refs/tags/${candidate.tag}^{}`])
      if (remote.split(/\s/)[0] !== candidate.sourceCommit)
        throw Error('Remote tag readback differs')
    }
  }
  if (candidate.tag)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `tag=${candidate.tag}\nsource_commit=${candidate.sourceCommit}\n`,
    )
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    candidate.tag
      ? `本轮${candidate.action === 'prepare' ? '准备' : '续作'}：\`${candidate.tag}\`，源码 \`${candidate.sourceCommit}\`。后续沿现有双平台发布流程执行。\n`
      : `${candidate.reason}，本轮跳过发布。\n`,
  )
  console.log(JSON.stringify(candidate))
  return candidate
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareDailyRelease(resolve(import.meta.dirname, '..'))
