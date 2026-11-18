/** Apply a pending Shell choice to the user patch before the official Desktop starts. */
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const TARGETS = {
  'bash-sandbox': ['@deepseek-ai/dsh-bash-sandbox', [true]],
  'pwsh-sandbox': ['@deepseek-ai/dsh-pwsh-sandbox', [true]],
  'opl-native-git-bash': ['@one-person-lab/dsh-opl/git-bash', [false]],
  'preset-standard': ['@deepseek-ai/dsh-agent-preset', [false, true]],
  'preset-cordis': ['@deepseek-ai/dsh-agent-preset', [false, true]],
  'preset-ptc': ['@deepseek-ai/dsh-agent-preset', [false, true]],
}
const TOOL_NAMES = ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh']
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function flatten(data) {
  return data.flatMap((entry) => [
    entry,
    ...(entry.group && Array.isArray(entry.config) ? flatten(entry.config) : []),
  ])
}
/** Preserve official Loader expressions when serializing copied preset configuration. */
function runtimeNode(yaml, doc, value) {
  if (value && typeof value === 'object' && typeof value.__jsExpr === 'string') {
    const node = new yaml.Scalar(value.__jsExpr)
    node.tag = 'tag:yaml.org,2002:js'
    return node
  }
  if (Array.isArray(value)) {
    const node = doc.createNode([])
    for (const item of value) node.add(runtimeNode(yaml, doc, item))
    return node
  }
  if (value && typeof value === 'object') {
    const node = doc.createNode({})
    for (const [key, item] of Object.entries(value)) node.set(key, runtimeNode(yaml, doc, item))
    return node
  }
  return doc.createNode(value)
}
/** Keep one config owner so later native Settings edits cannot be shadowed by an older copy. */
function configOwner(yaml, doc, id) {
  const rows = doc.contents.items.filter(
    (node) => yaml.isMap(node) && node.get('id') === id && !node.has('insert'),
  )
  if (!rows.length) {
    const row = doc.createNode({ id })
    doc.contents.add(row)
    return row
  }
  const owners = rows.filter((row) => row.has('config'))
  const last = owners.at(-1)?.get('config', true)
  const owner = rows.at(-1)
  if (last) owner.set('config', last.clone())
  for (const row of rows.slice(0, -1)) row.delete('config')
  return owner
}
async function applyPendingNativeShell({ dir, yaml, withFileLock, writeFileAtomic, compose }) {
  const file = join(dir, 'cordis.patch.yml')
  if (!existsSync(file)) return { changed: false }
  return withFileLock(
    file,
    async () => {
      const effective = flatten(await compose())
      const suite = effective.find((row) => row.id === 'opl-suite')
      const raw = suite?.config?.nativeShellReceipt
      if (!raw) return { changed: false }
      const receipt = JSON.parse(raw)
      if (!receipt?.pending) return { changed: false }
      if (typeof receipt.enabled !== 'boolean') throw Error('Shell 选择记录无效')
      if (
        !Array.isArray(receipt.entries) ||
        receipt.entries.length !== 6 ||
        new Set(receipt.entries.map((row) => row.id)).size !== 6
      )
        throw Error('Shell 恢复记录无效')
      const patches = []
      for (const row of receipt.entries) {
        const target = TARGETS[row.id]
        const matches = effective.filter((item) => item.id === row.id && item.name === row.name)
        if (
          !target ||
          target[0] !== row.name ||
          !equal(target[1], row.after) ||
          matches.length !== 1
        )
          throw Error('Shell 条目已变更，已拒绝覆盖')
        const entry = matches[0]
        const preset = row.id.startsWith('preset-')
        const plugins = preset
          ? TOOL_NAMES.map((name) => {
              const matches = entry.config?.plugins?.filter((plugin) => plugin.name === name)
              if (matches?.length !== 1) throw Error('官方预设 Shell 工具已变更')
              return matches[0]
            })
          : []
        const current = preset
          ? plugins.map((tool) => tool.disabled ?? null)
          : [entry.disabled ?? null]
        if (!equal(current, receipt.enabled === false ? row.after : row.before))
          throw Error('Shell 配置已由用户修改，已拒绝覆盖')
        if (preset) {
          const config = structuredClone(entry.config)
          for (const [index, name] of TOOL_NAMES.entries())
            config.plugins.find((plugin) => plugin.name === name).disabled = (
              receipt.enabled === false ? row.before : row.after
            )[index]
          patches.push({ id: row.id, name: row.name, config })
        } else
          patches.push({
            id: row.id,
            name: row.name,
            disabled: (receipt.enabled === false ? row.before : row.after)[0],
          })
      }
      const doc = yaml.parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
      if (doc.errors.length || !yaml.isSeq(doc.contents))
        throw Error('Git Bash 选择配置无法读取，已保留原文件')
      for (const patch of patches) {
        if (patch.config) {
          const row = configOwner(yaml, doc, patch.id)
          row.set('name', patch.name)
          row.set('config', runtimeNode(yaml, doc, patch.config))
        } else {
          const rows = doc.contents.items.filter(
            (node) => yaml.isMap(node) && node.get('id') === patch.id,
          )
          const row = rows.at(-1) ?? doc.createNode({ id: patch.id, name: patch.name })
          if (!rows.length) doc.contents.add(row)
          row.set('disabled', runtimeNode(yaml, doc, patch.disabled))
        }
      }
      const owner = configOwner(yaml, doc, 'opl-suite')
      let suiteConfig = owner.get('config', true)
      if (!suiteConfig) {
        suiteConfig = doc.createNode({})
        owner.set('config', suiteConfig)
      }
      if (!yaml.isMap(suiteConfig)) throw Error('OPL 用户设置不是映射，已保留原文件')
      suiteConfig.set(
        'nativeShellReceipt',
        receipt.enabled === false
          ? ''
          : JSON.stringify({ pending: false, entries: receipt.entries }),
      )
      await writeFileAtomic(file, String(doc), { mode: 0o600 })
      return { changed: true }
    },
    { waitMs: 1000 },
  )
}
async function main(application, dir) {
  if (process.platform !== 'win32') return
  await require('./ofm-owner.cjs').stopped(dir)
  const resources =
    process.platform === 'win32'
      ? join(application, 'resources')
      : join(application, 'Contents/Resources')
  const requireRuntime = createRequire(join(resources, 'app.asar/dsh/package.json'))
  const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href)
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const { applyEntryPatches } = await load('@deepseek-ai/cordis-plugin-include')
  const atomic = await load('@deepseek-ai/dsh-atomic-write')
  await runPendingNativeShell({
    dir,
    yaml: requireRuntime('yaml'),
    ...atomic,
    compose: () => {
      const profile = boot.loadProfileDirectory(
        'dsh',
        dir,
        requireRuntime.resolve('@deepseek-ai/dsh/package.json'),
      )
      return applyEntryPatches(
        [],
        [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches],
        (message) => {
          throw Error(message)
        },
      )
    },
  })
}
/** A failed opt-in never prevents Desktop startup or rewrites the user's patch. */
async function runPendingNativeShell(options) {
  try {
    return await applyPendingNativeShell(options)
  } catch (error) {
    const effective = flatten(await options.compose())
    const receipt =
      effective.find((row) => row.id === 'opl-suite')?.config?.nativeShellReceipt ?? ''
    const message = error instanceof Error ? error.message : 'Shell 选择未应用'
    await options.writeFileAtomic(
      join(options.dir, 'native-shell-status.json'),
      JSON.stringify({
        receiptHash: createHash('sha256').update(receipt).digest('hex'),
        message,
      }) + '\n',
      { mode: 0o600 },
    )
    return { changed: false, failed: true, message }
  }
}
if (require.main === module)
  main(...process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    try {
      writeFileSync(
        join(process.argv[3], 'native-shell-status.json'),
        JSON.stringify({ message: 'Shell 选择未应用：' + error.message }) + '\n',
        { mode: 0o600 },
      )
    } catch (writeError) {
      console.error('Shell 状态未能保存：' + writeError.message)
    }
  })
module.exports = { applyPendingNativeShell, runPendingNativeShell }
