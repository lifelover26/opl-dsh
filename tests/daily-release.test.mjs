import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  planDailyRelease,
  readPublishedOfficialVersion,
} from '../scripts/prepare-daily-release.mjs'
import { readOfficialDesktopFeeds } from '../scripts/official-desktop-feeds.mjs'
import { dailyReleaseNotes, writeDailyReleaseNotes } from '../scripts/daily-release-notes.mjs'
import { renderReleaseNotes } from '../scripts/release-notes.mjs'
import { prepareSharedReleaseNoteWriter } from '../scripts/prepare-shared-release-note-writer.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opl-daily-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Release fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  for (const dir of ['src', 'Casks', 'docs']) await mkdir(join(root, dir))
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.2.21' }))
  await writeFile(join(root, 'src/plugin.ts'), 'export const value = 1\n')
  await writeFile(join(root, 'Casks/opl-dsh.rb'), 'old metadata\n')
  git('add', '.')
  git('commit', '-m', 'Initial release')
  git('tag', 'opl-dsh-v0.2.21')
  const latest = { tag_name: 'opl-dsh-v0.2.21', draft: false, prerelease: false }
  const commit = () => {
    git('add', '.')
    git('commit', '-m', 'Fixture change')
  }
  return { root, git, latest, commit }
}

test('daily detection skips Cask follow-up and docs-only changes instead of releasing forever', async (t) => {
  const { root, latest, commit } = await fixture(t)
  await writeFile(join(root, 'Casks/opl-dsh.rb'), 'public release checksum\n')
  await writeFile(join(root, 'docs/release-policy.md'), 'Daily publication policy\n')
  commit()
  assert.equal((await planDailyRelease(root, latest)).action, 'skip')
})

test('an unversioned product fix gets the next stable patch', async (t) => {
  const { root, latest, commit } = await fixture(t)
  await writeFile(join(root, 'src/plugin.ts'), 'export const value = 2\n')
  commit()
  assert.deepEqual(await planDailyRelease(root, latest), {
    action: 'prepare',
    version: '0.2.22',
    baseline: latest.tag_name,
  })
})

test('an official-only update prepares one new patch, resumes it and skips after publication', async (t) => {
  const { root, git, latest, commit } = await fixture(t)
  const upstream = { officialVersion: '0.2.2-rc.1', publishedOfficialVersion: '0.2.1-rc.5' }
  assert.deepEqual(await planDailyRelease(root, latest, upstream), {
    action: 'prepare',
    version: '0.2.22',
    baseline: latest.tag_name,
  })
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.2.22' }))
  commit()
  git(
    'tag',
    '-a',
    'opl-dsh-v0.2.22',
    '-m',
    'OPL DSH v0.2.22\n\nOfficial DeepSeek Harness: 0.2.2-rc.1',
  )
  const frozen = git('rev-parse', 'HEAD')
  assert.deepEqual(await planDailyRelease(root, latest, upstream), {
    action: 'resume',
    tag: 'opl-dsh-v0.2.22',
    sourceCommit: frozen,
  })
  assert.equal(
    (
      await planDailyRelease(
        root,
        { ...latest, tag_name: 'opl-dsh-v0.2.22' },
        {
          officialVersion: upstream.officialVersion,
          publishedOfficialVersion: upstream.officialVersion,
        },
      )
    ).action,
    'skip',
  )
  assert.equal(
    (await planDailyRelease(root, latest, { ...upstream, officialVersion: '0.2.2-rc.2' })).version,
    '0.2.23',
  )
  assert.equal(git('rev-parse', 'opl-dsh-v0.2.22^{commit}'), frozen)
})

const feed = (version) =>
  `version: ${version}\npath: https://download.deepseek.com/desktop\nsha512: ${Buffer.alloc(64, 1).toString('base64')}\n`

test('upstream detection rejects incomplete, unavailable or divergent platform feeds', async () => {
  const feeds = await readOfficialDesktopFeeds(async () => new Response(feed('0.2.2-rc.1')))
  assert.equal(feeds['mac-arm64'].version, '0.2.2-rc.1')
  await assert.rejects(
    readOfficialDesktopFeeds(
      async (url) => new Response(feed(url.includes('mac-arm64') ? '0.2.2-rc.1' : '0.2.1-rc.5')),
    ),
    /disagree/,
  )
  await assert.rejects(
    readOfficialDesktopFeeds(async () => new Response('', { status: 503 })),
    /读取失败/,
  )
  await assert.rejects(
    readOfficialDesktopFeeds(async () => new Response('version: 0.2.2\n')),
    /缺少/,
  )
})

function publishedFixture(latest, officialVersion = '0.2.1-rc.5') {
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      tagName: latest.tag_name,
      releaseVersion: latest.tag_name.replace('opl-dsh-v', ''),
      official: { version: officialVersion },
      enhancement: {
        version: latest.tag_name.replace('opl-dsh-v', ''),
        sha256: 'sha256:' + 'a'.repeat(64),
        size: 1,
      },
    }),
  )
  return {
    bytes,
    latest: {
      ...latest,
      assets: [
        {
          id: 123,
          name: 'release-manifest.json',
          size: bytes.length,
          digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    },
  }
}

test('published official baseline comes from the exact digest-bound Latest manifest', () => {
  const { latest, bytes } = publishedFixture({ tag_name: 'opl-dsh-v0.2.21' })
  assert.equal(
    readPublishedOfficialVersion(latest, () => bytes),
    '0.2.1-rc.5',
  )
  assert.throws(() => readPublishedOfficialVersion(latest, () => Buffer.from('{}')), /checksum/)
  assert.throws(
    () => readPublishedOfficialVersion({ ...latest, tag_name: 'opl-dsh-v0.2.22' }, () => bytes),
    /tag/,
  )
  assert.throws(
    () => readPublishedOfficialVersion({ ...latest, assets: [] }, () => bytes),
    /manifest/,
  )
})

test('prepared versions are retained and a failed frozen candidate is resumed without a new tag', async (t) => {
  const { root, git, latest, commit } = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }))
  commit()
  assert.equal((await planDailyRelease(root, latest)).version, '0.3.0')
  git('tag', 'opl-dsh-v0.3.0')
  const frozen = git('rev-parse', 'HEAD')
  await writeFile(join(root, 'docs/status.md'), 'A later documentation change\n')
  commit()
  assert.deepEqual(await planDailyRelease(root, latest), {
    action: 'resume',
    tag: 'opl-dsh-v0.3.0',
    sourceCommit: frozen,
  })
})

test('dirty or divergent source and nonstable Latest fail before allocating a version', async (t) => {
  const { root, git, latest, commit } = await fixture(t)
  await writeFile(join(root, 'src/plugin.ts'), 'dirty\n')
  await assert.rejects(planDailyRelease(root, latest), /clean source/)
  commit()
  await assert.rejects(planDailyRelease(root, { ...latest, prerelease: true }), /canonical stable/)
  git('checkout', '--orphan', 'unrelated')
  git('commit', '-m', 'Unrelated root')
  await assert.rejects(planDailyRelease(root, latest))
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '0.2.21')
})

test('product fixes after a failed frozen candidate allocate a new patch without moving the tag', async (t) => {
  const { root, git, latest, commit } = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }))
  commit()
  git('tag', 'opl-dsh-v0.3.0')
  const frozen = git('rev-parse', 'opl-dsh-v0.3.0')
  await writeFile(join(root, 'src/plugin.ts'), 'export const value = 3\n')
  commit()
  assert.deepEqual(await planDailyRelease(root, latest), {
    action: 'prepare',
    version: '0.3.1',
    baseline: latest.tag_name,
  })
  assert.equal(git('rev-parse', 'opl-dsh-v0.3.0'), frozen)
  git('tag', 'opl-dsh-v0.3.1')
  assert.equal((await planDailyRelease(root, latest)).version, '0.3.2')
})

test('automatic Chinese release notes retain original commit text and render all provenance fields', () => {
  const changes =
    '- fix: preserve draft ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/abc))'
  const notes = renderReleaseNotes(dailyReleaseNotes({ changes }), {
    version: '0.2.22',
    officialVersion: '0.2.0-rc.2',
    sourceCommit: 'a'.repeat(40),
  })
  assert.ok(notes.startsWith('官方 DeepSeek Harness：'))
  assert.ok(notes.includes(changes))
  assert.ok(notes.includes('本版更新内容见以下提交记录及对应功能文档。'))
  assert.ok(!notes.includes('自动语言整理不可用'))
  assert.ok(notes.includes('a'.repeat(40)))
  assert.ok(!notes.includes('{{'))
})

const notesEvidence = {
  commitsMarkdown:
    '- fix: preserve draft ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/abc))',
  diff: '- overwrite draft\n+ preserve draft',
}

test('shared source download or import failure never prevents mechanical publication', async (t) => {
  const old = process.env.OPL_RELEASE_NOTES_WRITER_MODULE
  t.after(() => {
    if (old === undefined) delete process.env.OPL_RELEASE_NOTES_WRITER_MODULE
    else process.env.OPL_RELEASE_NOTES_WRITER_MODULE = old
  })
  assert.equal(
    await prepareSharedReleaseNoteWriter({
      request: async () => new Response('', { status: 503 }),
      install: false,
    }),
    null,
  )
  process.env.OPL_RELEASE_NOTES_WRITER_MODULE = '/missing-shared-note-writer/writer.mjs'
  const result = await writeDailyReleaseNotes(notesEvidence, {
    apiKey: 'gateway-fixture-secret',
    copilotToken: 'copilot-fixture-secret',
  })
  assert.equal(result.reason, 'shared_writer_unavailable')
  assert.equal(result.mode, 'mechanical')
  assert.ok(result.notes.includes(notesEvidence.commitsMarkdown))
})

test(
  'bootstrap resolves central main once and downloads immutable code and policy outside the product',
  { skip: !process.env.OPL_RELEASE_NOTES_WRITER_MODULE },
  async (t) => {
    const githubEnv = process.env.GITHUB_ENV
    delete process.env.GITHUB_ENV
    t.after(() => {
      if (githubEnv !== undefined) process.env.GITHUB_ENV = githubEnv
    })
    const source = new URL('file://' + process.env.OPL_RELEASE_NOTES_WRITER_MODULE)
    const calls = []
    const sha = 'a'.repeat(40)
    const result = await prepareSharedReleaseNoteWriter({
      install: false,
      request: async (url) => {
        calls.push(url)
        if (url.includes('/commits/')) return Response.json({ sha })
        assert.ok(url.includes('/' + sha + '/'))
        return new Response(
          await readFile(
            new URL(url.endsWith('policy.json') ? 'policy.json' : 'writer.mjs', source),
          ),
        )
      },
    })
    t.after(() => rm(new URL('.', 'file://' + result.module), { recursive: true, force: true }))
    assert.equal(calls.filter((url) => url.includes('/commits/')).length, 1)
    assert.equal(result.source_commit, sha)
    assert.ok(!result.module.startsWith(process.cwd() + '/'))
    const shared = await import('file://' + result.module)
    assert.equal(typeof shared.writeWithReleaseNoteFallback, 'function')
  },
)

test(
  'online writer uses the requested deepseek-flash and separates user copy from qualification facts',
  { skip: !process.env.OPL_RELEASE_NOTES_WRITER_MODULE },
  async () => {
    let calls = 0
    const result = await writeDailyReleaseNotes(notesEvidence, {
      apiKey: 'secret-fixture-key',
      request: async (url, options) => {
        calls++
        assert.equal(url, 'https://gateway.medopl.com/v1/chat/completions')
        const body = JSON.parse(options.body)
        assert.equal(body.model, 'deepseek-flash')
        assert.equal(JSON.parse(body.messages[1].content).diff, notesEvidence.diff)
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  overview: '编辑时保留已有草稿。',
                  changes: ['已有草稿不再被回填覆盖。'],
                  limitations: [],
                }),
              },
            },
          ],
        })
      },
    })
    assert.equal(calls, 1)
    assert.equal(result.mode, 'online-ai')
    assert.ok(result.notes.includes('已有草稿不再被回填覆盖'))
    assert.ok(result.notes.includes('OPL_DSH_RELEASE_NOTES:online-ai:deepseek-flash'))
    assert.ok(!result.notes.includes('secret-fixture-key'))
  },
)

test('credential absence, provider failures and malformed or incomplete replies always produce publishable mechanical notes', async () => {
  const requests = [
    async () => {
      throw Error('timeout with secret-fixture-key')
    },
    async () => new Response('', { status: 429 }),
    async () =>
      Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    async () => Response.json({ choices: [{ message: { content: 'not JSON' } }] }),
    async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: 'secret-fixture-key',
                changes: ['x'],
                limitations: [],
              }),
            },
          },
        ],
      }),
  ]
  const results = [await writeDailyReleaseNotes(notesEvidence)]
  for (const request of requests)
    results.push(
      await writeDailyReleaseNotes(notesEvidence, { apiKey: 'secret-fixture-key', request }),
    )
  for (const result of results) {
    assert.equal(result.mode, 'mechanical')
    assert.ok(result.notes.includes(notesEvidence.commitsMarkdown))
    assert.ok(result.notes.includes('OPL_DSH_RELEASE_NOTES:mechanical'))
    assert.ok(!JSON.stringify(result).includes('secret-fixture-key'))
    assert.doesNotThrow(() =>
      renderReleaseNotes(result.notes, {
        version: '0.2.22',
        officialVersion: '0.2.0-rc.2',
        sourceCommit: 'a'.repeat(40),
      }),
    )
  }
})

test(
  'Copilot auto succeeds before Gateway, and quota or invalid replies fall through in the required order',
  { skip: !process.env.OPL_RELEASE_NOTES_WRITER_MODULE },
  async () => {
    const copy = JSON.stringify({
      overview: '保留草稿。',
      changes: ['已有草稿不会被覆盖。'],
      limitations: [],
    })
    let gatewayCalls = 0
    const request = async () => {
      gatewayCalls++
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: copy } }] })
    }
    const options = { apiKey: 'gateway-secret', copilotToken: 'copilot-secret', request }
    const first = await writeDailyReleaseNotes(notesEvidence, {
      ...options,
      copilot: async () => copy,
    })
    assert.equal(first.model, 'copilot-auto')
    assert.equal(gatewayCalls, 0)
    assert.deepEqual(first.attempts, [{ provider: 'copilot-auto', status: 'passed' }])
    for (const copilot of [
      async () => {
        throw Error('quota exhausted with copilot-secret')
      },
      async () => 'invalid JSON',
    ]) {
      const second = await writeDailyReleaseNotes(notesEvidence, { ...options, copilot })
      assert.equal(second.model, 'deepseek-flash')
      assert.deepEqual(
        second.attempts.map(({ provider, status }) => [provider, status]),
        [
          ['copilot-auto', 'failed'],
          ['deepseek-flash', 'passed'],
        ],
      )
      assert.ok(!JSON.stringify(second).includes('copilot-secret'))
    }
    const third = await writeDailyReleaseNotes(notesEvidence, {
      ...options,
      copilot: async () => 'invalid',
      request: async () => new Response('', { status: 429 }),
    })
    assert.equal(third.mode, 'mechanical')
    assert.deepEqual(
      third.attempts.map(({ provider, status }) => [provider, status]),
      [
        ['copilot-auto', 'failed'],
        ['deepseek-flash', 'failed'],
        ['gpt-6-luna', 'failed'],
      ],
    )
    assert.doesNotThrow(() =>
      renderReleaseNotes(third.notes, {
        version: '0.2.22',
        officialVersion: '0.2.0-rc.2',
        sourceCommit: 'a'.repeat(40),
      }),
    )
  },
)

for (const { prepared, upstreamOnly } of [
  { prepared: false, upstreamOnly: false },
  { prepared: true, upstreamOnly: false },
  { prepared: false, upstreamOnly: true },
])
  test(
    upstreamOnly
      ? 'an official-only update runs the real preparation once and resumes its frozen target'
      : prepared
        ? 'precommitted version and notes freeze without an empty commit, then resume'
        : 'real preparation pushes one frozen candidate and the next run resumes it',
    { skip: process.platform === 'win32' },
    async (t) => {
      const { root, git, latest, commit } = await fixture(t)
      const external = await mkdtemp(join(tmpdir(), 'opl-daily-remote-'))
      t.after(() => rm(external, { recursive: true, force: true }))
      const remote = join(external, 'origin.git')
      execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
      git('remote', 'add', 'origin', remote)
      await mkdir(join(root, 'scripts'))
      for (const file of [
        'prepare-daily-release.mjs',
        'daily-release-notes.mjs',
        'official-desktop-feeds.mjs',
      ])
        await copyFile(new URL('../scripts/' + file, import.meta.url), join(root, 'scripts', file))
      await mkdir(join(root, 'installer'))
      await copyFile(
        new URL('../installer/release-manifest.mjs', import.meta.url),
        join(root, 'installer/release-manifest.mjs'),
      )
      await writeFile(
        join(root, 'package-lock.json'),
        JSON.stringify({ version: '0.2.21', packages: { '': { version: '0.2.21' } } }),
      )
      if (!upstreamOnly) await writeFile(join(root, 'src/plugin.ts'), 'export const value = 2\n')
      if (prepared) {
        for (const file of ['package.json', 'package-lock.json']) {
          const value = JSON.parse(await readFile(join(root, file), 'utf8'))
          value.version = '0.2.22'
          if (value.packages?.['']) value.packages[''].version = '0.2.22'
          await writeFile(join(root, file), JSON.stringify(value, null, 2) + '\n')
        }
        await writeFile(join(root, 'docs/release-notes-0.2.22.md'), '维护者已准备的发布说明\n')
      }
      commit()
      // The official-only case must have no unpublished product bytes at all.
      if (upstreamOnly) git('tag', '-f', latest.tag_name)
      const preparedCommit = git('rev-parse', 'HEAD')
      git('push', 'origin', 'main', '--tags')
      const bin = join(external, 'bin')
      await mkdir(bin)
      // Latest metadata/manifest are simulated; version writes, commits, tags, pushes,
      // remote readback and workflow outputs use the actual production entry point.
      await writeFile(
        join(bin, 'gh'),
        `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('repos/gaofeng21cn/opl-dsh/releases/latest') ? ${JSON.stringify(JSON.stringify(publishedFixture(latest).latest))} : ${JSON.stringify(publishedFixture(latest).bytes.toString())})\n`,
        { mode: 0o700 },
      )
      // Keep the real preparation and Git mutation entry; only upstream HTTP is injected.
      const runner = join(external, 'run.mjs')
      const officialVersion = upstreamOnly ? '0.2.2-rc.1' : '0.2.1-rc.5'
      await writeFile(
        runner,
        `import { prepareDailyRelease } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/prepare-daily-release.mjs')).href)}; await prepareDailyRelease(${JSON.stringify(root)}, {request: async () => new Response(${JSON.stringify(feed(officialVersion))})});`,
      )
      const output = join(external, 'output')
      const env = {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        GITHUB_REPOSITORY: 'gaofeng21cn/opl-dsh',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(external, 'summary'),
      }
      delete env.OPL_RELEASE_NOTES_CODEX_API_KEY
      delete env.GITHUB_TOKEN
      const run = () =>
        JSON.parse(
          execFileSync(process.execPath, [runner], {
            cwd: root,
            env,
            encoding: 'utf8',
          })
            .trim()
            .split('\n')
            .at(-1),
        )
      const first = run()
      assert.equal(first.action, 'prepare')
      assert.equal(first.tag, 'opl-dsh-v0.2.22')
      assert.equal(git('rev-parse', 'HEAD'), first.sourceCommit)
      if (prepared) {
        assert.equal(first.sourceCommit, preparedCommit)
        assert.equal(
          await readFile(join(root, 'docs/release-notes-0.2.22.md'), 'utf8'),
          '维护者已准备的发布说明\n',
        )
      }
      assert.ok(
        git('ls-remote', 'origin', 'refs/tags/opl-dsh-v0.2.22^{}').startsWith(first.sourceCommit),
      )
      const lock = JSON.parse(await readFile(join(root, 'package-lock.json')))
      assert.equal(lock.version, '0.2.22')
      assert.equal(lock.packages[''].version, '0.2.22')
      assert.ok((await readFile(output, 'utf8')).includes('tag=opl-dsh-v0.2.22'))
      assert.ok((await readFile(output, 'utf8')).includes(`official_version=${officialVersion}`))
      assert.ok(
        git('for-each-ref', '--format=%(contents)', 'refs/tags/opl-dsh-v0.2.22').includes(
          `Official DeepSeek Harness: ${officialVersion}`,
        ),
      )
      if (upstreamOnly) {
        const notes = await readFile(join(root, 'docs/release-notes-0.2.22.md'), 'utf8')
        assert.ok(notes.includes('0.2.1-rc.5') && notes.includes('0.2.2-rc.1'))
      }
      const second = run()
      assert.equal(second.action, 'resume')
      assert.equal(second.sourceCommit, first.sourceCommit)
      assert.equal(git('status', '--porcelain'), '')
      if (upstreamOnly) {
        await writeFile(
          runner,
          `import { prepareDailyRelease } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/prepare-daily-release.mjs')).href)}; await prepareDailyRelease(${JSON.stringify(root)}, {request: async () => new Response(${JSON.stringify(feed('0.2.2-rc.2'))})});`,
        )
        assert.throws(
          () =>
            execFileSync(process.execPath, [runner], {
              cwd: root,
              env: { ...env, GITHUB_REF: 'refs/tags/opl-dsh-v0.2.22' },
              stdio: 'pipe',
            }),
          /Official feeds changed after this tag was frozen/,
        )
        assert.equal(git('rev-parse', 'HEAD'), first.sourceCommit)
        assert.equal(git('rev-parse', 'opl-dsh-v0.2.22^{commit}'), first.sourceCommit)
        assert.equal(git('status', '--porcelain'), '')
      }
    },
  )

test(
  'Gateway flash failure falls through to luna before mechanical notes',
  { skip: !process.env.OPL_RELEASE_NOTES_WRITER_MODULE },
  async () => {
    const models = []
    const result = await writeDailyReleaseNotes(notesEvidence, {
      apiKey: 'gateway-secret',
      copilotToken: 'copilot-secret',
      copilot: async () => 'invalid',
      request: async (_url, options) => {
        const model = JSON.parse(options.body).model
        models.push(model)
        if (model === 'deepseek-flash') return new Response('', { status: 429 })
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  overview: '保留草稿。',
                  changes: ['草稿不会被覆盖。'],
                  limitations: [],
                }),
              },
            },
          ],
        })
      },
    })
    assert.equal(result.model, 'gpt-6-luna')
    assert.deepEqual(models, ['deepseek-flash', 'gpt-6-luna'])
  },
)

test('large or unavailable diffs still reach the writer with bounded, explicit evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opl-note-evidence-'))
  const old = process.env.OPL_RELEASE_NOTES_WRITER_MODULE
  t.after(async () => {
    if (old === undefined) delete process.env.OPL_RELEASE_NOTES_WRITER_MODULE
    else process.env.OPL_RELEASE_NOTES_WRITER_MODULE = old
    await rm(root, { recursive: true, force: true })
  })
  const writer = join(root, 'writer.mjs')
  await writeFile(
    writer,
    `export async function writeWithReleaseNoteFallback(messages, validate) {
    const evidence = JSON.parse(messages[1].content);
    if (evidence.diff.length > 100100 || !evidence.commitDetails.includes('Preserve draft')) throw Error('bad evidence');
    if (!/incomplete|unavailable/.test(evidence.evidenceNotice)) throw Error('missing limitation');
    return {value: validate(JSON.stringify({overview:'保留草稿。',changes:['编辑时保留草稿。'],limitations:[]}), 'fixture', []),writer:{attempts:[{status:'passed'}]}};
  }`,
  )
  process.env.OPL_RELEASE_NOTES_WRITER_MODULE = writer
  for (const evidence of [
    { diff: 'diff --git a/src/a.ts b/src/a.ts\n' + 'x'.repeat(600000), diffComplete: true },
    { diff: '', diffComplete: false },
  ]) {
    const result = await writeDailyReleaseNotes({
      ...notesEvidence,
      ...evidence,
      commitDetails: 'Preserve draft when editing',
    })
    assert.equal(result.mode, 'online-ai')
    assert.match(result.notes, /编辑时保留草稿/)
    assert.equal(result.attempts.length, 1)
  }
})
