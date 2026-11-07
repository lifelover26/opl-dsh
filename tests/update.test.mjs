import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import childProcess from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { deflateRawSync, crc32 } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  prepareUpdate,
  cancelPreparedUpdate,
  readPreparedUpdate,
  refreshEnhancements,
  isLocalCandidateInstall,
} from '../installer/update.mjs'
import { validateReleaseManifest } from '../installer/release-manifest.mjs'

const officialVersion = '0.2.2-rc.1'
const repository = 'https://github.com/gaofeng21cn/opl-dsh'
const api = 'https://api.github.com/repos/gaofeng21cn/opl-dsh/releases/latest'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const pendingFile = (root) => join(root, 'enhancement-pending.json')

function payload(version = '0.2.56', patch = {}) {
  const name = `opl-dsh-enhancements-${version}.tgz`
  const entries = new Map(
    [
      'install.mjs',
      'profile.cjs',
      'model-plugins.cjs',
      'kimi-cu.mjs',
      'setup.mjs',
      'update.mjs',
      'skill-install.mjs',
      'migrate.cjs',
      'skill/SKILL.md',
      name,
    ].map((path) => [path, Buffer.from(`${version}: ${path}\n`)]),
  )
  const payloadFiles = Object.fromEntries([...entries].map(([path, bytes]) => [path, hash(bytes)]))
  const artifact = {
    version: officialVersion,
    officialVersion,
    enhancementVersion: version,
    updateProtocolVersion: 1,
    unattendedUpdateProtocolVersion: 1,
    name,
    sha256: hash(entries.get(name)),
    payloadFiles,
    suiteSha256: hash(JSON.stringify(payloadFiles)),
    sourceDirty: false,
    ...patch,
  }
  entries.set('artifact.json', Buffer.from(JSON.stringify(artifact)))
  return { artifact, entries }
}

// Fixture ZIPs use the same documented classic ZIP fields as Python zipfile.
function zip(entries, options = {}) {
  const locals = [],
    central = []
  let offset = 0,
    count = 0
  for (const [name, bytes] of entries) {
    const encoded = Buffer.from(name),
      content = Buffer.from(bytes),
      compressed = deflateRawSync(content)
    const local = Buffer.alloc(30),
      record = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(content), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(encoded.length, 26)
    record.writeUInt32LE(0x02014b50)
    record.writeUInt16LE(0x314, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(8, 10)
    record.writeUInt32LE(crc32(content), 16)
    record.writeUInt32LE(compressed.length, 20)
    record.writeUInt32LE(content.length, 24)
    record.writeUInt16LE(encoded.length, 28)
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    options.entry?.(name, local, record)
    locals.push(local, encoded, compressed)
    central.push(record, encoded)
    offset += local.length + encoded.length + compressed.length
    count++
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function releaseFixture(target = payload(), archive = zip(target.entries), manifestPatch = {}) {
  const version = target.artifact.enhancementVersion,
    tag = `opl-dsh-v${version}`
  const manifest = {
    schemaVersion: 1,
    channel: 'stable',
    releaseVersion: version,
    tagName: tag,
    official: { version: target.artifact.officialVersion },
    enhancement: {
      version,
      asset: 'OPL-DSH-Enhancements.zip',
      sha256: 'sha256:' + hash(archive),
      size: archive.length,
      updateProtocolVersion: 1,
      unattendedUpdateProtocolVersion: 1,
    },
    ...manifestPatch,
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const asset = (name, bytes) => ({
    name,
    size: bytes.length,
    digest: 'sha256:' + hash(bytes),
    browser_download_url: `${repository}/releases/download/${tag}/${name}`,
  })
  return {
    target,
    archive,
    manifestBytes,
    release: {
      tag_name: tag,
      draft: false,
      prerelease: false,
      html_url: `${repository}/releases/tag/${tag}`,
      published_at: '2026-11-07T00:00:00Z',
      assets: [
        asset('OPL-DSH-Enhancements.zip', archive),
        asset('release-manifest.json', manifestBytes),
      ],
    },
  }
}

function remote(t, value, override) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const address = String(url)
    calls.push(address)
    const result = await override?.(address, options)
    if (result !== undefined) return result
    if (address === api) return Response.json(value.release)
    if (address.endsWith('/release-manifest.json')) return new Response(value.manifestBytes)
    if (address.endsWith('/OPL-DSH-Enhancements.zip')) return new Response(value.archive)
    throw Error('unexpected URL')
  })
  return calls
}

async function fixture(t, { localCandidate = false, originalPatch = {} } = {}) {
  // Simulate a supported target for installer logic on Linux-only unit-test hosts.
  if (
    !(
      (process.platform === 'win32' && process.arch === 'x64') ||
      (process.platform === 'darwin' && process.arch === 'arm64')
    )
  ) {
    for (const [key, value] of [
      ['platform', 'win32'],
      ['arch', 'x64'],
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(process, key)
      Object.defineProperty(process, key, { ...descriptor, value })
      t.after(() => Object.defineProperty(process, key, descriptor))
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'opl-update-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const old = payload('0.2.55', originalPatch),
    application = join(root, 'official-app')
  const home = join(root, 'data'),
    release = join(root, 'releases', old.artifact.suiteSha256)
  for (const [path, bytes] of old.entries) {
    await mkdir(dirname(join(release, path)), { recursive: true })
    await writeFile(join(release, path), bytes)
  }
  await mkdir(join(home, 'profiles/desktop'), { recursive: true })
  await mkdir(join(home, 'opl-dsh'), { recursive: true })
  const receipt = {
    version: 3,
    suiteRoot: root,
    home,
    profileHome: home,
    release,
    app: application,
    suiteVersion: '0.2.55',
    officialVersion,
    suiteSha256: old.artifact.suiteSha256,
    enhancementSha256: old.artifact.sha256,
    localCandidate,
    skillDir: join(root, 'codex/skills/opl-dsh-official'),
    installedAt: '2026-11-06T00:00:00Z',
  }
  const originalBytes = JSON.stringify(receipt) + '\n'
  await writeFile(join(root, 'installation.json'), originalBytes)
  await writeFile(join(home, 'opl-dsh/installation.json'), originalBytes)
  const state = {
    officialVersion,
    installs: [],
    failNew: false,
    failRollback: false,
    unconfirmed: false,
  }
  const install = (source, args) => {
    const artifact = JSON.parse(readFileSync(join(source, 'artifact.json'), 'utf8'))
    const destination = join(root, 'releases', artifact.suiteSha256)
    mkdirSync(dirname(destination), { recursive: true })
    if (source !== destination) cpSync(source, destination, { recursive: true })
    const next = {
      ...receipt,
      suiteVersion:
        state.unconfirmed && artifact.enhancementVersion !== '0.2.55'
          ? '0.0.0'
          : artifact.enhancementVersion,
      release: destination,
      suiteSha256: artifact.suiteSha256,
      enhancementSha256: artifact.sha256,
      localCandidate: args.includes('--local-candidate'),
      installedAt: new Date().toISOString(),
    }
    writeFileSync(join(root, 'installation.json'), JSON.stringify(next) + '\n')
    writeFileSync(join(home, 'opl-dsh/installation.json'), JSON.stringify(next) + '\n')
  }
  const mocked = t.mock.method(childProcess, 'spawnSync', (executable, args, options) => {
    if (args[0] === '-e') return { status: 0, stdout: state.officialVersion }
    assert.ok(args.includes('--no-launch'))
    assert.ok(args.includes('--update-if-stopped'))
    state.installs.push(args)
    const source = args[3],
      rollback = source === release
    if (rollback && state.failRollback) return { status: 2 }
    install(source, args)
    return { status: !rollback && state.failNew ? 1 : 0 }
  })
  syncBuiltinESMExports()
  t.after(() => {
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
  return { root, home, application, receipt, old, originalBytes, state }
}

test('stable release manifest binds the official desktop and OPL version', () => {
  const value = releaseFixture()
  const manifest = JSON.parse(value.manifestBytes.toString('utf8'))
  assert.equal(
    validateReleaseManifest(manifest, { tagName: value.release.tag_name }).releaseVersion,
    '0.2.56',
  )
  assert.throws(() => validateReleaseManifest({ ...manifest, tagName: 'dsh-v0.2.2-opl.56' }), /tag/)
  assert.equal(isLocalCandidateInstall({ sourceDirty: false }, []), false)
  assert.equal(isLocalCandidateInstall({ sourceDirty: true }, []), true)
  assert.equal(isLocalCandidateInstall({ sourceDirty: false }, ['--local-candidate']), true)
})

test('ordinary startup never checks, downloads or executes an updater without a pending request', async (t) => {
  const value = await fixture(t)
  const calls = remote(t, releaseFixture())
  await refreshEnhancements(value.root, value.application)
  assert.equal(calls.length, 0)
  assert.equal(value.state.installs.length, 0)
  assert.equal(await readFile(join(value.root, 'installation.json'), 'utf8'), value.originalBytes)
  assert.equal(await readPreparedUpdate(value.root), null)
  await assert.rejects(readFile(join(value.root, 'enhancement-update.lock')), { code: 'ENOENT' })
})

test('a candidate is replaced only after explicit prepare and a later stopped startup', async (t) => {
  const value = await fixture(t, { localCandidate: true }),
    release = releaseFixture()
  const calls = remote(t, release)
  const prepared = await prepareUpdate(value.root, value.application, { expectedVersion: '0.2.56' })
  assert.equal(prepared.version, '0.2.56')
  assert.deepEqual(await readPreparedUpdate(value.root), {
    version: '0.2.56',
    preparedAt: prepared.preparedAt,
  })
  assert.equal(value.state.installs.length, 0)
  assert.equal(await readFile(join(value.root, 'installation.json'), 'utf8'), value.originalBytes)
  assert.equal(calls.length, 3)
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('startup must not discover or download')
  })
  await refreshEnhancements(value.root, value.application)
  assert.equal(value.state.installs.length, 1)
  assert.equal(await readPreparedUpdate(value.root), null)
  const installed = JSON.parse(await readFile(join(value.root, 'installation.json'), 'utf8'))
  assert.equal(installed.suiteVersion, '0.2.56')
  assert.equal(installed.localCandidate, false)
  assert.equal(
    await readFile(join(value.receipt.release, 'install.mjs'), 'utf8'),
    value.old.entries.get('install.mjs').toString('utf8'),
  )
  assert.equal(
    JSON.parse(await readFile(join(value.root, 'enhancement-update.json'), 'utf8')).state,
    'updated',
  )
})

test('old, incompatible and no-longer-accepted releases never download the ZIP', async (t) => {
  for (const scenario of [
    'same',
    'older',
    'official',
    'expected',
    'original-protocol',
    'release-protocol',
  ]) {
    await t.test(scenario, async (t) => {
      const value = await fixture(t, {
        originalPatch: scenario === 'original-protocol' ? { updateProtocolVersion: undefined } : {},
      })
      const target = payload(
        scenario === 'same' ? '0.2.55' : scenario === 'older' ? '0.2.54' : '0.2.56',
        scenario === 'official' ? { officialVersion: '0.2.2-rc.2' } : {},
      )
      const release = releaseFixture(target)
      if (scenario === 'release-protocol') {
        const manifest = JSON.parse(release.manifestBytes.toString('utf8'))
        delete manifest.enhancement.updateProtocolVersion
        release.manifestBytes = Buffer.from(JSON.stringify(manifest))
        release.release.assets[1].size = release.manifestBytes.length
        release.release.assets[1].digest = 'sha256:' + hash(release.manifestBytes)
      }
      const calls = remote(t, release)
      await assert.rejects(
        prepareUpdate(value.root, value.application, {
          expectedVersion: scenario === 'expected' ? '0.2.57' : undefined,
        }),
      )
      assert.equal(calls.length, 2)
      assert.equal(await readPreparedUpdate(value.root), null)
      assert.equal(value.state.installs.length, 0)
      assert.equal(
        await readFile(join(value.root, 'installation.json'), 'utf8'),
        value.originalBytes,
      )
    })
  }
})

test('prepare refuses a changed official app or a foreign installation path before network access', async (t) => {
  const value = await fixture(t),
    calls = remote(t, releaseFixture())
  value.state.officialVersion = '0.2.2-rc.2'
  await assert.rejects(prepareUpdate(value.root, value.application), /官方桌面/)
  await assert.rejects(prepareUpdate(value.root, join(value.root, 'foreign-app')), /原安装/)
  assert.equal(calls.length, 0)
  assert.equal(value.state.installs.length, 0)
})

test('invalid archives and unverified executable bytes cannot create a pending plan', async (t) => {
  const cases = [
    [
      'payload-hash',
      (target) => {
        target.entries.set('install.mjs', Buffer.from('changed installer'))
      },
    ],
    [
      'suite-hash',
      (target) => {
        target.artifact.suiteSha256 = '0'.repeat(64)
        target.entries.set('artifact.json', Buffer.from(JSON.stringify(target.artifact)))
      },
    ],
    [
      'artifact-protocol',
      (target) => {
        delete target.artifact.updateProtocolVersion
        target.entries.set('artifact.json', Buffer.from(JSON.stringify(target.artifact)))
      },
    ],
    [
      'extra-code',
      (target) => {
        target.entries.set('unlisted.mjs', Buffer.from('unverified'))
      },
    ],
    [
      'traversal',
      (target) => {
        target.entries.set('../escape.mjs', Buffer.from('escape'))
      },
    ],
    [
      'windows-alias',
      (target) => {
        target.entries.set('NUL.txt', Buffer.from('alias'))
      },
    ],
    [
      'windows-stream',
      (target) => {
        target.entries.set('install.mjs:stream', Buffer.from('stream'))
      },
    ],
    [
      'case-duplicate',
      (target) => {
        target.entries.set('INSTALL.mjs', Buffer.from('duplicate'))
      },
    ],
    [
      'missing-required',
      (target) => {
        target.entries.delete('update.mjs')
        delete target.artifact.payloadFiles['update.mjs']
        target.artifact.suiteSha256 = hash(JSON.stringify(target.artifact.payloadFiles))
        target.entries.set('artifact.json', Buffer.from(JSON.stringify(target.artifact)))
      },
    ],
    [
      'symlink',
      () => {},
      {
        entry: (name, _local, record) => {
          if (name === 'install.mjs') record.writeUInt32LE((0o120777 << 16) >>> 0, 38)
        },
      },
    ],
    [
      'expanded-size',
      () => {},
      {
        entry: (name, _local, record) => {
          if (name === 'install.mjs') record.writeUInt32LE(257 * 1024 * 1024, 24)
        },
      },
    ],
  ]
  for (const [name, mutate, zipOptions] of cases) {
    await t.test(name, async (t) => {
      const value = await fixture(t),
        target = payload()
      mutate(target)
      remote(t, releaseFixture(target, zip(target.entries, zipOptions)))
      await assert.rejects(prepareUpdate(value.root, value.application))
      assert.equal(await readPreparedUpdate(value.root), null)
      assert.equal(value.state.installs.length, 0)
      assert.equal(
        await readFile(join(value.root, 'installation.json'), 'utf8'),
        value.originalBytes,
      )
      await assert.rejects(readFile(join(value.root, 'enhancement-update.lock')), {
        code: 'ENOENT',
      })
    })
  }
})

test('network errors, wrong ZIP digests and cancelled downloads leave the original install usable', async (t) => {
  for (const scenario of ['offline', 'digest', 'oversize', 'abort', 'changed-installation']) {
    await t.test(scenario, async (t) => {
      const value = await fixture(t),
        release = releaseFixture(),
        controller = new AbortController()
      remote(t, release, async (url) => {
        if (!url.endsWith('/OPL-DSH-Enhancements.zip')) return undefined
        if (scenario === 'offline') throw Error('fixture download failed')
        if (scenario === 'digest') return new Response(Buffer.alloc(release.archive.length))
        if (scenario === 'oversize') return new Response(Buffer.alloc(release.archive.length + 1))
        if (scenario === 'abort') controller.abort()
        if (scenario === 'changed-installation')
          await writeFile(join(value.root, 'installation.json'), value.originalBytes + ' ')
        return new Response(release.archive)
      })
      await assert.rejects(
        prepareUpdate(value.root, value.application, { signal: controller.signal }),
      )
      assert.equal(await readPreparedUpdate(value.root), null)
      assert.equal(value.state.installs.length, 0)
      if (scenario !== 'changed-installation')
        assert.equal(
          await readFile(join(value.root, 'installation.json'), 'utf8'),
          value.originalBytes,
        )
      await assert.rejects(readFile(join(value.root, 'enhancement-update.lock')), {
        code: 'ENOENT',
      })
    })
  }
})

test('cancel removes only the pending request and leaves staged and previous packages intact', async (t) => {
  const value = await fixture(t)
  remote(t, releaseFixture())
  await prepareUpdate(value.root, value.application)
  const plan = JSON.parse(await readFile(pendingFile(value.root), 'utf8'))
  await cancelPreparedUpdate(value.root)
  await cancelPreparedUpdate(value.root)
  assert.equal(await readPreparedUpdate(value.root), null)
  assert.ok((await readFile(join(value.root, 'updates', plan.stage, 'payload.zip'))).length > 0)
  assert.equal(await readFile(join(value.root, 'installation.json'), 'utf8'), value.originalBytes)
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('cancelled startup must stay offline')
  })
  await refreshEnhancements(value.root, value.application)
  assert.equal(value.state.installs.length, 0)
})

test('a failed second preparation preserves an already accepted pending request', async (t) => {
  const value = await fixture(t)
  remote(t, releaseFixture())
  await prepareUpdate(value.root, value.application)
  const accepted = await readFile(pendingFile(value.root), 'utf8')
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('offline second check')
  })
  await assert.rejects(prepareUpdate(value.root, value.application), /offline/)
  assert.equal(await readFile(pendingFile(value.root), 'utf8'), accepted)
})

test('cancellation between the optimistic pending read and lock acquisition prevents installation', async (t) => {
  const value = await fixture(t)
  remote(t, releaseFixture())
  await prepareUpdate(value.root, value.application)
  const originalOpen = fsPromises.open
  let cancelBeforeLock = true
  const mocked = t.mock.method(fsPromises, 'open', async (path, ...args) => {
    if (String(path).endsWith('enhancement-update.lock') && cancelBeforeLock) {
      cancelBeforeLock = false
      await cancelPreparedUpdate(value.root)
    }
    return originalOpen(path, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
  await refreshEnhancements(value.root, value.application)
  assert.equal(cancelBeforeLock, false)
  assert.equal(value.state.installs.length, 0)
  assert.equal(await readPreparedUpdate(value.root), null)
})

test('stale identities, tampered plans and files, and every running profile defer the pending update', async (t) => {
  for (const scenario of [
    'receipt',
    'official',
    'old-payload',
    'payload',
    'zip',
    'plan',
    'manifest',
    'running',
    'other-profile',
  ]) {
    await t.test(scenario, async (t) => {
      const value = await fixture(t)
      remote(t, releaseFixture())
      await prepareUpdate(value.root, value.application)
      const pendingBytes = await readFile(pendingFile(value.root), 'utf8'),
        plan = JSON.parse(pendingBytes)
      const stage = join(value.root, 'updates', plan.stage)
      if (scenario === 'receipt')
        await writeFile(join(value.root, 'installation.json'), value.originalBytes + ' ')
      if (scenario === 'official') value.state.officialVersion = '0.2.2-rc.2'
      if (scenario === 'old-payload')
        await writeFile(join(value.receipt.release, 'profile.cjs'), 'changed original')
      if (scenario === 'payload')
        await writeFile(join(stage, 'payload/install.mjs'), 'tampered executable')
      if (scenario === 'zip') await writeFile(join(stage, 'payload.zip'), 'tampered archive')
      if (scenario === 'plan') {
        plan.stage = '../foreign'
        await writeFile(pendingFile(value.root), JSON.stringify(plan))
      }
      if (scenario === 'manifest') {
        plan.metadata.manifestText += ' '
        await writeFile(pendingFile(value.root), JSON.stringify(plan))
      }
      if (scenario === 'running' || scenario === 'other-profile') {
        const profile = join(
          value.home,
          'profiles',
          scenario === 'running' ? 'desktop' : 'research',
        )
        await mkdir(profile, { recursive: true })
        await writeFile(join(profile, 'control.json'), JSON.stringify({ pid: process.pid }))
      }
      t.mock.method(globalThis, 'fetch', async () => {
        throw Error('startup must be offline')
      })
      await refreshEnhancements(value.root, value.application)
      assert.equal(value.state.installs.length, 0)
      assert.ok((await readFile(pendingFile(value.root))).length > 0)
      const status = JSON.parse(await readFile(join(value.root, 'enhancement-update.json'), 'utf8'))
      assert.equal(status.state, 'deferred')
      assert.equal(status.trigger, 'prepared-launcher')
      await assert.rejects(readFile(join(value.root, 'enhancement-update.lock')), {
        code: 'ENOENT',
      })
    })
  }
})

test('a live updater lock prevents concurrent prepare and cancel without changing pending state', async (t) => {
  const value = await fixture(t)
  remote(t, releaseFixture())
  await prepareUpdate(value.root, value.application)
  const accepted = await readFile(pendingFile(value.root), 'utf8')
  await writeFile(join(value.root, 'enhancement-update.lock'), JSON.stringify({ pid: process.pid }))
  await assert.rejects(prepareUpdate(value.root, value.application), /正在进行/)
  await assert.rejects(cancelPreparedUpdate(value.root), /正在进行/)
  await refreshEnhancements(value.root, value.application)
  assert.equal(await readFile(pendingFile(value.root), 'utf8'), accepted)
  assert.equal(value.state.installs.length, 0)
  assert.equal(
    JSON.parse(await readFile(join(value.root, 'enhancement-update.lock'), 'utf8')).pid,
    process.pid,
  )
})

test('stale lock recovery rechecks ownership before removing a lock', async (t) => {
  for (const takeover of [false, true]) {
    await t.test(takeover ? 'new-live-owner' : 'stale-owner', async (t) => {
      const value = await fixture(t)
      remote(t, releaseFixture())
      const lockPath = join(value.root, 'enhancement-update.lock')
      await writeFile(lockPath, JSON.stringify({ pid: 999999 }))
      const originalKill = process.kill
      t.mock.method(process, 'kill', (pid, signal) => {
        if (pid === 999999) throw Object.assign(Error('fixture stale owner'), { code: 'ESRCH' })
        return originalKill.call(process, pid, signal)
      })
      if (takeover) {
        const originalOpen = fsPromises.open
        const mocked = t.mock.method(fsPromises, 'open', async (path, ...args) => {
          if (String(path).endsWith('.recovery'))
            await writeFile(lockPath, JSON.stringify({ pid: process.pid }))
          return originalOpen(path, ...args)
        })
        syncBuiltinESMExports()
        t.after(() => {
          mocked.mock.restore()
          syncBuiltinESMExports()
        })
        await assert.rejects(prepareUpdate(value.root, value.application), /正在进行/)
        assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid)
      } else {
        await prepareUpdate(value.root, value.application)
        assert.equal((await readPreparedUpdate(value.root)).version, '0.2.56')
        await assert.rejects(readFile(lockPath), { code: 'ENOENT' })
      }
      await assert.rejects(readFile(`${lockPath}.recovery`), { code: 'ENOENT' })
      assert.equal(value.state.installs.length, 0)
    })
  }
})

test('failed installation and failed confirmation roll back and preserve the accepted plan', async (t) => {
  for (const scenario of ['install-failed', 'confirmation-failed', 'rollback-failed']) {
    await t.test(scenario, async (t) => {
      const value = await fixture(t, { localCandidate: true })
      remote(t, releaseFixture())
      await prepareUpdate(value.root, value.application)
      value.state.failNew = scenario !== 'confirmation-failed'
      value.state.unconfirmed = scenario === 'confirmation-failed'
      value.state.failRollback = scenario === 'rollback-failed'
      await refreshEnhancements(value.root, value.application)
      assert.equal(value.state.installs.length, 2)
      assert.ok(value.state.installs[1].includes('--local-candidate'))
      assert.equal((await readPreparedUpdate(value.root)).version, '0.2.56')
      const status = JSON.parse(await readFile(join(value.root, 'enhancement-update.json'), 'utf8'))
      assert.equal(status.state, 'deferred')
      assert.equal(status.rollback, scenario === 'rollback-failed' ? 'failed' : 'succeeded')
      if (scenario !== 'rollback-failed') {
        assert.equal(
          await readFile(join(value.root, 'installation.json'), 'utf8'),
          value.originalBytes,
        )
        assert.equal(
          await readFile(join(value.home, 'opl-dsh/installation.json'), 'utf8'),
          value.originalBytes,
        )
      }
      assert.equal(
        await readFile(join(value.receipt.release, 'install.mjs'), 'utf8'),
        value.old.entries.get('install.mjs').toString('utf8'),
      )
    })
  }
})

test('payload symlinks are refused before any installer invocation', async (t) => {
  const value = await fixture(t)
  remote(t, releaseFixture())
  await prepareUpdate(value.root, value.application)
  const plan = JSON.parse(await readFile(pendingFile(value.root), 'utf8'))
  const path = join(value.root, 'updates', plan.stage, 'payload/skill')
  await rm(path, { recursive: true })
  const foreign = join(value.root, 'foreign-skill')
  await mkdir(foreign)
  await writeFile(join(foreign, 'SKILL.md'), 'foreign')
  await symlink(foreign, path, process.platform === 'win32' ? 'junction' : 'dir')
  await refreshEnhancements(value.root, value.application)
  assert.equal(value.state.installs.length, 0)
  assert.equal((await readPreparedUpdate(value.root)).version, '0.2.56')
  assert.equal(await readFile(join(foreign, 'SKILL.md'), 'utf8'), 'foreign')
})
