/** Install upstream model plugins once; their own managers retain update ownership. */
const {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  cpSync,
  rmSync,
} = require('node:fs')
const { join } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const MODEL_PLUGINS = [
  {
    name: 'dsh-our-free-model',
    version: '2.8.0',
    source:
      'https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/download/v2.8.0/dsh-our-free-model-2.8.0.tgz',
    sha256: '2dc255aeddd46d1f37ed53916ab0cbfe2081412ace8ae3d2c59b38b9b78eba3b',
  },
]

/** Keep a verified original release archive in the profile for later repair. */
async function prepareModelPlugin({ dir, plugin, fetchImpl = fetch }) {
  const archive = join(dir, 'vendor', `${plugin.name}-${plugin.version}.tgz`)
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  if (existsSync(archive)) {
    if (digest(readFileSync(archive)) !== plugin.sha256)
      throw Error(`模型插件归档校验失败：${plugin.name}`)
    return archive
  }
  const response = await fetchImpl(plugin.source, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw Error(`模型插件下载失败：${plugin.name}（HTTP ${response.status}）`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (digest(bytes) !== plugin.sha256) throw Error(`模型插件归档校验失败：${plugin.name}`)
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

async function installModelPlugins({ dir, install, plugins = MODEL_PLUGINS, fetchImpl = fetch }) {
  for (const plugin of plugins) {
    const profile = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (Object.hasOwn(profile.dependencies ?? {}, plugin.name)) {
      // Preserve user versions, sources and disabled bundles. Repair a missing
      // installation from the existing manifest/lock rather than choosing a version.
      if (!existsSync(join(dir, 'node_modules', plugin.name, 'package.json')))
        await install(['install'])
      continue
    }
    const archive = await prepareModelPlugin({ dir, plugin, fetchImpl })
    await install(['add', archive])
  }
}

/** pnpm may re-extract unchanged tarball dependencies when updating another package. */
async function preserveModelPlugins({ dir, install }) {
  const retained = MODEL_PLUGINS.filter((plugin) =>
    existsSync(join(dir, 'node_modules', plugin.name, 'package.json')),
  )
  if (!retained.length) return install()
  const backup = mkdtempSync(join(dir, '.opl-model-plugins-'))
  for (const plugin of retained)
    cpSync(join(dir, 'node_modules', plugin.name), join(backup, plugin.name), { recursive: true })
  try {
    return await install()
  } finally {
    // The profile is stopped. Restore all original bytes, including files added
    // by an upstream update; source/version selection remains in the profile.
    // A failed restore retains the complete backup instead of deleting recovery.
    for (const plugin of retained) {
      const installed = join(dir, 'node_modules', plugin.name)
      rmSync(installed, { recursive: true, force: true })
      cpSync(join(backup, plugin.name), installed, { recursive: true })
    }
    rmSync(backup, { recursive: true })
  }
}

module.exports = { MODEL_PLUGINS, prepareModelPlugin, installModelPlugins, preserveModelPlugins }
