import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { checkRelease, newer } from '../installer/update-discovery.mjs'

const repository = 'https://github.com/gaofeng21cn/opl-dsh'
const api = 'https://api.github.com/repos/gaofeng21cn/opl-dsh/releases/latest'
const hash = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const current = {
  suiteVersion: '0.2.55',
  officialVersion: '0.2.2-rc.1',
  platform: 'win32',
  arch: 'x64',
}

function fixture({
  version = '0.2.56',
  officialVersion = current.officialVersion,
  manifestPatch = {},
} = {}) {
  const tag = `opl-dsh-v${version}`,
    payload = Buffer.from('payload must not be downloaded during discovery')
  const manifest = {
    schemaVersion: 1,
    channel: 'stable',
    releaseVersion: version,
    tagName: tag,
    official: { version: officialVersion },
    enhancement: {
      version,
      asset: 'OPL-DSH-Enhancements.zip',
      sha256: hash(payload),
      size: payload.length,
      updateProtocolVersion: 1,
      unattendedUpdateProtocolVersion: 1,
    },
    ...manifestPatch,
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const asset = (name, bytes) => ({
    name,
    size: bytes.length,
    digest: hash(bytes),
    browser_download_url: `${repository}/releases/download/${tag}/${name}`,
  })
  return {
    manifest,
    manifestBytes,
    payload,
    release: {
      tag_name: tag,
      draft: false,
      prerelease: false,
      html_url: `${repository}/releases/tag/${tag}`,
      published_at: '2026-11-07T00:00:00Z',
      assets: [
        asset('OPL-DSH-Enhancements.zip', payload),
        asset('release-manifest.json', manifestBytes),
      ],
    },
  }
}

function remote(t, value, manifestResponse = () => new Response(value.manifestBytes)) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url))
    assert.equal(options.redirect, 'manual')
    if (String(url) === api) return Response.json(value.release)
    if (String(url).endsWith('/release-manifest.json')) return manifestResponse()
    throw Error('discovery attempted a payload download')
  })
  return calls
}

test('stable versions advance numerically and reject malformed versions and prereleases', () => {
  assert.equal(newer('0.10.0', '0.2.0'), true)
  assert.equal(newer('0.2.5', '0.2.4'), true)
  for (const version of ['0.2.0', '0.1.9', '0.3.0-rc.1', 'bad', '00.3.0', '9007199254740992.0.0'])
    assert.equal(newer(version, '0.2.0'), false)
  assert.equal(newer('0.2.19', '0.2.18-minimax.20261008.2'), false)
})

test('checks download only stable metadata and its digest-bound manifest, including candidates', async (t) => {
  const value = fixture(),
    calls = remote(t, value)
  const result = await checkRelease({ ...current, localCandidate: true })
  assert.deepEqual(result.release, {
    version: '0.2.56',
    officialVersion: current.officialVersion,
    url: value.release.html_url,
    publishedAt: value.release.published_at,
    compatibility: 'enhancement',
  })
  assert.equal(result.metadata.asset.digest, hash(value.payload))
  assert.equal(result.metadata.manifestText, value.manifestBytes.toString('utf8'))
  assert.deepEqual(calls, [api, value.release.assets[1].browser_download_url])
})

test('same and older versions stop after the manifest and never download the ZIP', async (t) => {
  for (const version of ['0.2.55', '0.2.54']) {
    const value = fixture({ version }),
      calls = remote(t, value)
    assert.deepEqual(await checkRelease(current), { release: null, metadata: null })
    assert.equal(calls.length, 2)
  }
})

test('official version and supported platform determine enhancement compatibility', async (t) => {
  remote(t, fixture())
  for (const input of [
    { ...current, officialVersion: '0.2.2-rc.2' },
    { ...current, platform: 'linux' },
    { ...current, arch: 'arm64' },
    { ...current, platform: 'darwin', arch: 'x64' },
  ])
    assert.equal((await checkRelease(input)).release.compatibility, 'full-suite')
  assert.equal(
    (await checkRelease({ ...current, platform: 'darwin', arch: 'arm64' })).release.compatibility,
    'enhancement',
  )
  const legacy = fixture()
  delete legacy.manifest.enhancement.updateProtocolVersion
  legacy.manifestBytes = Buffer.from(JSON.stringify(legacy.manifest))
  legacy.release.assets[1].size = legacy.manifestBytes.length
  legacy.release.assets[1].digest = hash(legacy.manifestBytes)
  remote(t, legacy)
  assert.equal((await checkRelease(current)).release.compatibility, 'full-suite')
})

test('draft, prerelease and missing stable releases return no candidate', async (t) => {
  const value = fixture(),
    calls = remote(t, value)
  value.release.draft = true
  assert.equal((await checkRelease(current)).release, null)
  value.release.draft = false
  value.release.prerelease = true
  assert.equal((await checkRelease(current)).release, null)
  assert.equal(calls.length, 2)
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
  assert.equal((await checkRelease(current)).release, null)
})

test('malicious release tags, URLs, asset digests, sizes and duplicates are refused before asset fetch', async (t) => {
  const mutations = [
    (r) => {
      r.tag_name = 'opl-dsh-v0.2.56/../../other'
    },
    (r) => {
      r.html_url += '?redirect=evil'
    },
    (r) => {
      r.assets[0].browser_download_url = 'https://github.com.evil.example/payload'
    },
    (r) => {
      r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace(
        'v0.2.56',
        'v0.2.57',
      )
    },
    (r) => {
      r.assets[1].browser_download_url += '?raw=1'
    },
    (r) => {
      r.assets[0].digest = 'sha256:bad'
    },
    (r) => {
      r.assets[1].digest = null
    },
    (r) => {
      r.assets[0].size = 0
    },
    (r) => {
      r.assets[0].size = -1
    },
    (r) => {
      r.assets[0].size = 32 * 1024 * 1024 + 1
    },
    (r) => {
      r.assets[1].size = 128 * 1024 + 1
    },
    (r) => {
      r.assets.push(r.assets[0])
    },
  ]
  for (const mutate of mutations) {
    const value = fixture()
    mutate(value.release)
    const calls = remote(t, value)
    await assert.rejects(checkRelease(current))
    assert.equal(calls.length, 1)
  }
})

test('manifest digest, exact size and version/asset binding are verified', async (t) => {
  let value = fixture()
  remote(t, value, () => new Response(Buffer.alloc(value.manifestBytes.length)))
  await assert.rejects(checkRelease(current), /SHA-256/)
  remote(t, value, () => new Response('short'))
  await assert.rejects(checkRelease(current), /SHA-256/)
  value = fixture({ manifestPatch: { tagName: 'opl-dsh-v0.2.57' } })
  remote(t, value)
  await assert.rejects(checkRelease(current), /tag/)
  value = fixture({
    manifestPatch: {
      enhancement: {
        version: '0.2.56',
        asset: 'OPL-DSH-Enhancements.zip',
        sha256: hash('other'),
        size: 4,
      },
    },
  })
  remote(t, value)
  await assert.rejects(checkRelease(current), /资产不符/)
})

test('streamed responses stop at the declared asset limit even without content-length', async (t) => {
  const value = fixture()
  remote(t, value, () => new Response(new Uint8Array(value.manifestBytes.length + 1)))
  await assert.rejects(checkRelease(current), /大小上限/)
})

test('asset redirects accept GitHub storage and refuse a foreign destination', async (t) => {
  const value = fixture(),
    calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    if (String(url) === api) return Response.json(value.release)
    if (String(url).endsWith('/release-manifest.json'))
      return new Response(null, {
        status: 302,
        headers: {
          location:
            'https://release-assets.githubusercontent.com/github-production-release-asset/manifest?signature=test',
        },
      })
    if (String(url).startsWith('https://release-assets.githubusercontent.com/'))
      return new Response(value.manifestBytes)
    throw Error('unexpected download')
  })
  assert.equal((await checkRelease(current)).release.version, '0.2.56')
  assert.equal(calls.length, 3)
  remote(
    t,
    value,
    () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/manifest' } }),
  )
  await assert.rejects(checkRelease(current), /重定向地址/)
})

test('abort and failed downloads leave discovery to the caller without fetching a payload', async (t) => {
  const controller = new AbortController()
  controller.abort()
  const calls = remote(t, fixture())
  await assert.rejects(checkRelease(current, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls.length, 0)
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('offline')
  })
  await assert.rejects(checkRelease(current), /offline/)
})
