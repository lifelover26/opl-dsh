/** Install the official model plugin through the Desktop's package manager. */
const {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} = require('node:fs')
const { join } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const MODEL_PLUGINS = [
  {
    name: 'dsh-our-free-model',
    version: '2.8.3',
    source:
      'https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/download/v2.8.3/dsh-our-free-model-2.8.3.tgz',
    assetSource:
      'https://api.github.com/repos/Ebony-Vinyl/dsh-our-free-model/releases/assets/723134923',
    sha256: '8685535a657693d2d524673d6fa1d13146faa724490359aa85753269b13da60a',
    sha512:
      '0b3d66e9813889b01d23bb99cbd7aad0c34bf2ec0c096c48d4aba3f278f5c8f9a1f253aa40492520762c0cd7e720f47b491db694bfb29e1eb1a70a7b12c4ec74',
  },
]

/** Keep a verified original release archive in the profile for later repair. */
async function prepareModelPlugin({ dir, plugin, fetchImpl = fetch }) {
  const archive = join(dir, 'vendor', `${plugin.name}-${plugin.version}.tgz`)
  const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex')
  const verify = (bytes) => {
    if (digest(bytes, 'sha256') !== plugin.sha256)
      throw Error(`模型插件归档校验失败：${plugin.name}`)
    if (plugin.sha512 !== undefined && digest(bytes, 'sha512') !== plugin.sha512)
      throw Error(`模型插件归档校验失败：${plugin.name}`)
  }
  if (existsSync(archive)) {
    verify(readFileSync(archive))
    return archive
  }
  const signal = AbortSignal.timeout(120_000)
  let response = await fetchImpl(plugin.source, { signal })
  // The release page route may fail while GitHub's exact asset route is healthy.
  // Try that same pinned archive once, within the original download deadline.
  if ([502, 503, 504].includes(response.status) && plugin.assetSource) {
    await response.body?.cancel()
    response = await fetchImpl(plugin.assetSource, {
      signal,
      headers: { Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' },
    })
  }
  if (!response.ok) throw Error(`模型插件下载失败：${plugin.name}（HTTP ${response.status}）`)
  const bytes = Buffer.from(await response.arrayBuffer())
  verify(bytes)
  mkdirSync(join(dir, 'vendor'), { recursive: true, mode: 0o700 })
  const temporary = `${archive}.${randomUUID()}`
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, archive)
  } finally {
    rmSync(temporary, { force: true })
  }
  return archive
}

async function installModelPlugins({
  dir,
  install,
  plugins = MODEL_PLUGINS,
  fetchImpl = fetch,
  restoreBundles,
}) {
  for (const plugin of plugins) {
    if (plugin.name === 'dsh-our-free-model') {
      await require('./ofm-upgrade.cjs').migrateOfmLink({
        dir,
        install,
        plugin,
        fetchImpl,
        restoreBundles,
      })
      continue
    }
    const profile = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (Object.hasOwn(profile.dependencies ?? {}, plugin.name)) continue
    const archive = await prepareModelPlugin({ dir, plugin, fetchImpl })
    await install(['add', archive])
  }
}

/** Reconcile OPL dependencies without replacing OFM's profile-local link target. */
async function preserveModelPlugins({ dir, install }) {
  return install()
}

module.exports = { MODEL_PLUGINS, prepareModelPlugin, installModelPlugins, preserveModelPlugins }
