import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, link, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions,
  inspectOfm,
  isPackageManagerOwned,
  readOfmState,
  upgradeOfm,
} from '../installer/ofm-upgrade.cjs'

const archiveBytes = Buffer.from('official OFM release fixture')
const fixturePlugin = {
  name: 'dsh-our-free-model',
  version: '2.8.3',
  source: 'https://example.test/ofm-2.8.3.tgz',
  sha256: createHash('sha256').update(archiveBytes).digest('hex'),
  sha512: createHash('sha512').update(archiveBytes).digest('hex'),
}

async function profile(version, dependency = 'file:vendor/old.tgz') {
  const dir = await mkdtemp(join(tmpdir(), 'opl-ofm-upgrade-'))
  await mkdir(join(dir, 'node_modules/dsh-our-free-model'), { recursive: true })
  await mkdir(join(dir, 'store'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-our-free-model': dependency } }) + '\n',
  )
  await writeFile(join(dir, 'profile-settings.json'), '{"keep":true}\n')
  await writeFile(
    join(dir, 'store/package.json'),
    JSON.stringify({ name: 'dsh-our-free-model', version }),
  )
  await link(
    join(dir, 'store/package.json'),
    join(dir, 'node_modules/dsh-our-free-model/package.json'),
  )
  await writeFile(join(dir, 'store/index.js'), 'old package')
  await link(join(dir, 'store/index.js'), join(dir, 'node_modules/dsh-our-free-model/index.js'))
  return dir
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true })
}

async function download(url) {
  assert.equal(url, fixturePlugin.source)
  return new Response(archiveBytes)
}

function manager(dir, calls, { failAdd = false } = {}) {
  return async (args) => {
    calls.push(args)
    const manifestPath = join(dir, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (args[0] === 'add' && args[1] === 'dsh-our-free-model@file:vendor/old.tgz') {
      manifest.dependencies['dsh-our-free-model'] = 'file:vendor/old.tgz'
      await writeFile(manifestPath, JSON.stringify(manifest) + '\n')
      const packageDir = join(dir, 'node_modules/dsh-our-free-model')
      await rm(packageDir, { recursive: true, force: true })
      await mkdir(packageDir, { recursive: true })
      await mkdir(join(dir, 'store-restored'), { recursive: true })
      await writeFile(
        join(dir, 'store-restored/package.json'),
        JSON.stringify({ version: '2.8.0' }),
      )
      await link(join(dir, 'store-restored/package.json'), join(packageDir, 'package.json'))
      await writeFile(join(dir, 'store-restored/index.js'), 'restored package')
      await link(join(dir, 'store-restored/index.js'), join(packageDir, 'index.js'))
    } else if (args[0] === 'add') {
      manifest.dependencies['dsh-our-free-model'] = 'file:vendor/dsh-our-free-model-2.8.3.tgz'
      await writeFile(manifestPath, JSON.stringify(manifest) + '\n')
      const packageDir = join(dir, 'node_modules/dsh-our-free-model')
      await rm(packageDir, { recursive: true, force: true })
      await mkdir(packageDir, { recursive: true })
      await mkdir(join(dir, 'store-next'), { recursive: true })
      await writeFile(join(dir, 'store-next/package.json'), JSON.stringify({ version: '2.8.3' }))
      await link(join(dir, 'store-next/package.json'), join(packageDir, 'package.json'))
      if (failAdd) throw Error('simulated pnpm failure')
      await writeFile(join(dir, 'store-next/index.js'), 'new package')
      await link(join(dir, 'store-next/index.js'), join(packageDir, 'index.js'))
    } else if (args[0] === 'remove') {
      delete manifest.dependencies['dsh-our-free-model']
      await writeFile(manifestPath, JSON.stringify(manifest) + '\n')
      await rm(join(dir, 'node_modules/dsh-our-free-model'), { recursive: true, force: true })
    }
  }
}

test('semver comparison keeps a higher installed OFM version', () => {
  assert.equal(compareVersions('2.8.3', '2.8.3'), 0)
  assert.equal(compareVersions('2.8.4', '2.8.3'), 1)
  assert.equal(compareVersions('2.8.3-beta.2', '2.8.3-beta.10'), -1)
})

test('upgrade uses official pnpm, keeps profile data, and retains managed hard links', async () => {
  const dir = await profile('2.8.0')
  try {
    const calls = []
    const result = await upgradeOfm({
      dir,
      plugin: fixturePlugin,
      fetchImpl: download,
      install: manager(dir, calls),
      now: () => '2026-11-10T00:00:00.000Z',
    })
    assert.equal(result.phase, 'succeeded')
    assert.equal(result.versionAfter, '2.8.3')
    assert.equal(result.managed, true)
    assert.deepEqual(calls, [['add', join(dir, 'vendor/dsh-our-free-model-2.8.3.tgz')]])
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'profile-settings.json'), 'utf8')), {
      keep: true,
    })
    assert.equal(await isPackageManagerOwned(join(dir, 'node_modules/dsh-our-free-model')), true)
    assert.equal((await inspectOfm(dir)).installedVersion, '2.8.3')
    assert.equal((await readOfmState(dir)).phase, 'succeeded')
  } finally {
    await cleanup(dir)
  }
})

test('higher installed version is retained without downloading or changing the manifest', async () => {
  const dir = await profile('3.0.0', 'file:/user/ofm-3.0.0.tgz')
  try {
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    const calls = []
    const result = await upgradeOfm({
      dir,
      plugin: fixturePlugin,
      fetchImpl: async () => assert.fail('a higher installed version must not download'),
      install: manager(dir, calls),
    })
    assert.equal(result.phase, 'skipped')
    assert.equal(result.managed, true)
    assert.deepEqual(calls, [])
    assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), before)
  } finally {
    await cleanup(dir)
  }
})

test('failed pnpm update restores the manifest and retains only package metadata for recovery', async () => {
  const dir = await profile('2.8.0')
  try {
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    const calls = []
    await mkdir(join(dir, 'node_modules/dsh-our-free-model/data'), { recursive: true })
    await writeFile(join(dir, 'node_modules/dsh-our-free-model/data/private.json'), 'user data')
    await assert.rejects(
      upgradeOfm({
        dir,
        plugin: fixturePlugin,
        fetchImpl: download,
        install: manager(dir, calls, { failAdd: true }),
      }),
      (error) => {
        assert.equal(error.recovery, 'restored-by-pnpm')
        return /simulated pnpm failure/u.test(error.message)
      },
    )
    assert.deepEqual(
      calls.map((args) => args[0]),
      ['add', 'add'],
    )
    assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), before)
    assert.equal((await inspectOfm(dir)).installedVersion, '2.8.0')
    assert.equal((await inspectOfm(dir)).managed, true)
    const state = await readOfmState(dir)
    assert.equal(state.phase, 'recovered')
    assert.equal(
      JSON.parse(
        await readFile(
          join(state.recoveryPath, 'node_modules/dsh-our-free-model/package.json'),
          'utf8',
        ),
      ).version,
      '2.8.0',
    )
    for (const name of ['index.js', 'data/private.json'])
      await assert.rejects(
        readFile(join(state.recoveryPath, 'node_modules/dsh-our-free-model', name)),
        { code: 'ENOENT' },
      )
  } finally {
    await cleanup(dir)
  }
})

test('a live transaction lock rejects a second updater', async () => {
  const dir = await profile('2.8.0')
  const lock = await open(join(dir, '.ofm-upgrade.lock'), 'wx', 0o600)
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, transactionId: 'fixture' }))
    await assert.rejects(
      upgradeOfm({
        dir,
        plugin: fixturePlugin,
        install: async () => assert.fail('the locked updater must not invoke pnpm'),
      }),
      (error) => error.code === 'ofm-upgrade-in-progress',
    )
  } finally {
    await lock.close()
    await cleanup(dir)
  }
})
