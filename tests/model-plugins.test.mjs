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
  sha512: createHash('sha512').update(archiveBytes).digest('hex'),
}

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

for (const status of [502, 503, 504])
  test(`HTTP ${status} uses the same GitHub asset once and verifies its archive`, async () => {
    await profile({}, async (dir) => {
      const requests = []
      let cancelled = false
      const archive = await prepareModelPlugin({
        dir,
        plugin: fixturePlugin,
        fetchImpl: async (url, options) => {
          requests.push({ url, options })
          if (requests.length === 1)
            return new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true
                },
              }),
              { status },
            )
          assert.equal(cancelled, true)
          assert.equal(url, fixturePlugin.assetSource)
          assert.equal(options.headers.Accept, 'application/octet-stream')
          assert.equal(options.signal, requests[0].options.signal)
          return new Response(archiveBytes)
        },
      })
      assert.deepEqual(
        requests.map(({ url }) => url),
        [fixturePlugin.source, fixturePlugin.assetSource],
      )
      assert.deepEqual(await readFile(archive), archiveBytes)
    })
  })

for (const status of [403, 404])
  test(`HTTP ${status} is rejected without changing the download route`, async () => {
    await profile({}, async (dir) => {
      const requests = []
      await assert.rejects(
        prepareModelPlugin({
          dir,
          plugin: fixturePlugin,
          fetchImpl: async (url) => {
            requests.push(url)
            return new Response('unavailable', { status })
          },
        }),
        new RegExp(`HTTP ${status}`),
      )
      assert.deepEqual(requests, [fixturePlugin.source])
    })
  })

test('a corrupt archive from the GitHub asset route never reaches the installer', async () => {
  await profile({}, async (dir) => {
    const requests = []
    await assert.rejects(
      installModelPlugins({
        dir,
        plugins: [fixturePlugin],
        fetchImpl: async (url) => {
          requests.push(url)
          return requests.length === 1
            ? new Response('unavailable', { status: 504 })
            : new Response('wrong archive')
        },
        install: async () => assert.fail('corrupt recovery archive must not be installed'),
      }),
      /归档校验失败/,
    )
    assert.deepEqual(requests, [fixturePlugin.source, fixturePlugin.assetSource])
    await assert.rejects(
      readFile(join(dir, 'vendor', `${fixturePlugin.name}-${fixturePlugin.version}.tgz`)),
      { code: 'ENOENT' },
    )
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
      const requests = []
      await assert.rejects(
        installModelPlugins({
          dir,
          plugins: [fixturePlugin],
          fetchImpl: async (url) => {
            requests.push(url)
            return response.create()
          },
          install: async () => assert.fail('invalid archive must not reach the manager'),
        }),
        response.error,
      )
      assert.deepEqual(
        requests,
        response.name === 'failed download'
          ? [fixturePlugin.source, fixturePlugin.assetSource]
          : [fixturePlugin.source],
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

test('OPL package installation delegates without rewriting package-manager-owned bytes', async () => {
  await profile({ dependencies: { 'dsh-our-free-model': 'original-source' } }, async (dir) => {
    const installed = join(dir, 'node_modules/dsh-our-free-model')
    await mkdir(installed, { recursive: true })
    await writeFile(join(installed, 'package.json'), '{"version":"3.0.0"}')
    const calls = []
    await preserveModelPlugins({ dir, install: async (args) => calls.push(args) })
    assert.deepEqual(calls, [undefined])
    assert.equal(await readFile(join(installed, 'package.json'), 'utf8'), '{"version":"3.0.0"}')
  })
})

async function ownedOfm(
  dir,
  { version = '2.8.0', sourceVersion = version, enabled = true, source, archive = true } = {},
) {
  const path = join(dir, 'vendor', `dsh-our-free-model-${sourceVersion}.tgz`)
  await mkdir(join(dir, 'vendor'), { recursive: true })
  if (archive) await writeFile(path, 'retained old release archive')
  await mkdir(join(dir, 'node_modules/dsh-our-free-model'), { recursive: true })
  await writeFile(
    join(dir, 'node_modules/dsh-our-free-model/package.json'),
    JSON.stringify({ name: 'dsh-our-free-model', version }),
  )
  const manifest = {
    dependencies: {
      'dsh-our-free-model': source ?? `file:${path.split(String.fromCharCode(92)).join('/')}`,
    },
    dsh: { profile: { bundles: enabled ? ['dsh-our-free-model'] : [] } },
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
  return manifest
}
