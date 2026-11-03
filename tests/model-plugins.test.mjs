import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODEL_PLUGINS,
  prepareModelPlugin,
  installModelPlugins,
  preserveModelPlugins,
} from '../installer/model-plugins.cjs'

async function profile(manifest, run) {
  const dir = await mkdtemp(join(tmpdir(), 'opl-model-plugins-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const archiveBytes = Buffer.from('verified upstream archive')
const fixturePlugin = {
  ...MODEL_PLUGINS[0],
  sha256: createHash('sha256').update(archiveBytes).digest('hex'),
}

test('first installation delegates the verified complete archive to the official manager', async () => {
  await profile({ dependencies: { 'user-plugin': '1.0.0' } }, async (dir) => {
    const calls = []
    const requests = []
    await installModelPlugins({
      dir,
      plugins: [fixturePlugin],
      fetchImpl: async (url) => {
        requests.push(url)
        return new Response(archiveBytes)
      },
      install: async (args) => calls.push(args),
    })
    const archive = join(dir, 'vendor', `${fixturePlugin.name}-${fixturePlugin.version}.tgz`)
    assert.deepEqual(requests, [fixturePlugin.source])
    assert.deepEqual(calls, [['add', archive]])
    assert.deepEqual(await readFile(archive), archiveBytes)
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')), {
      dependencies: { 'user-plugin': '1.0.0' },
    })
  })
})

test('a verified archive can be reused without a download', async () => {
  await profile({}, async (dir) => {
    const first = await prepareModelPlugin({
      dir,
      plugin: fixturePlugin,
      fetchImpl: async () => new Response(archiveBytes),
    })
    const second = await prepareModelPlugin({
      dir,
      plugin: fixturePlugin,
      fetchImpl: async () => assert.fail('verified archive must be reused'),
    })
    assert.equal(first, second)
    assert.deepEqual(await readFile(second), archiveBytes)
  })
})

test('a changed cached archive is retained and rejected before installation', async () => {
  await profile({}, async (dir) => {
    const archive = await prepareModelPlugin({
      dir,
      plugin: fixturePlugin,
      fetchImpl: async () => new Response(archiveBytes),
    })
    await writeFile(archive, 'changed bytes')
    await assert.rejects(
      installModelPlugins({
        dir,
        plugins: [fixturePlugin],
        fetchImpl: async () => assert.fail('must not replace a changed local archive'),
        install: async () => assert.fail('must not install changed bytes'),
      }),
      /归档校验失败/,
    )
    assert.equal(await readFile(archive, 'utf8'), 'changed bytes')
  })
})

for (const response of [
  {
    name: 'failed download',
    create: () => new Response('unavailable', { status: 503 }),
    error: /HTTP 503/,
  },
  { name: 'checksum mismatch', create: () => new Response('wrong archive'), error: /归档校验失败/ },
])
  test(`${response.name} leaves the profile unchanged and never invokes the manager`, async () => {
    await profile({ dependencies: { 'user-plugin': '1.0.0' } }, async (dir) => {
      await assert.rejects(
        installModelPlugins({
          dir,
          plugins: [fixturePlugin],
          fetchImpl: async () => response.create(),
          install: async () => assert.fail('invalid archive must not reach the manager'),
        }),
        response.error,
      )
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')), {
        dependencies: { 'user-plugin': '1.0.0' },
      })
      await assert.rejects(
        readFile(join(dir, 'vendor', `${fixturePlugin.name}-${fixturePlugin.version}.tgz`)),
        { code: 'ENOENT' },
      )
    })
  })

for (const version of ['2.7.4', '3.0.0'])
  test(`OPL reinstall preserves a user-selected source, installed ${version} and disabled bundle`, async () => {
    const manifest = {
      dependencies: { 'dsh-our-free-model': `file:/user/ofm-${version}.tgz` },
      dsh: { profile: { bundles: ['@one-person-lab/dsh-opl'] } },
    }
    await profile(manifest, async (dir) => {
      const installed = join(dir, 'node_modules/dsh-our-free-model')
      await mkdir(installed, { recursive: true })
      await writeFile(join(installed, 'package.json'), JSON.stringify({ version }))
      await installModelPlugins({
        dir,
        fetchImpl: async () => assert.fail('must not download'),
        install: async () => assert.fail('must not reinstall'),
      })
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')), manifest)
      assert.equal(
        JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version,
        version,
      )
    })
  })

test('repair restores the existing profile instead of replacing the upstream dependency', async () => {
  await profile({ dependencies: { 'dsh-our-free-model': 'file:/user/ofm.tgz' } }, async (dir) => {
    const calls = []
    await installModelPlugins({ dir, install: async (args) => calls.push(args) })
    assert.deepEqual(calls, [['install']])
  })
})

for (const failed of [false, true])
  test(`OPL package installation preserves self-updated plugin bytes after ${failed ? 'failure' : 'success'}`, async () => {
    await profile({ dependencies: { 'dsh-our-free-model': 'original-source' } }, async (dir) => {
      const installed = join(dir, 'node_modules/dsh-our-free-model')
      await mkdir(installed, { recursive: true })
      await writeFile(join(installed, 'package.json'), '{"version":"3.0.0"}')
      await writeFile(join(installed, 'upstream-new-file.js'), 'original upstream bytes')
      const result = preserveModelPlugins({
        dir,
        install: async () => {
          await rm(installed, { recursive: true })
          await mkdir(installed)
          await writeFile(join(installed, 'package.json'), '{"version":"2.1.0"}')
          await writeFile(join(installed, 'old-version-file.js'), 'old bytes')
          if (failed) throw Error('pnpm failed')
        },
      })
      if (failed) await assert.rejects(result, /pnpm failed/)
      else await result
      assert.equal(await readFile(join(installed, 'package.json'), 'utf8'), '{"version":"3.0.0"}')
      assert.equal(
        await readFile(join(installed, 'upstream-new-file.js'), 'utf8'),
        'original upstream bytes',
      )
      await assert.rejects(readFile(join(installed, 'old-version-file.js')), { code: 'ENOENT' })
    })
  })
