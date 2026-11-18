/** Move only OPL-owned settings while preserving YAML expressions and user overrides. */
const { readFileSync, existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const FIELDS = {
  'opl-execution': ['executionLimits', 'rememberPermissionPreset', 'toolAutoReview'],
  'opl-collaboration': [
    'cooperation',
    'roleExecutions',
    'wakeTransport',
    'wakeExecutable',
    'wakeExecution',
    'wakeDistro',
  ],
}
async function migrateSplitSettings({ dir, yaml, withFileLock, writeFileAtomic, stopped }) {
  const file = join(dir, 'cordis.patch.yml')
  if (!existsSync(file)) return
  await withFileLock(
    file,
    async () => {
      await stopped(dir)
      const original = readFileSync(file, 'utf8')
      const document = yaml.parseDocument(original, { logLevel: 'silent' })
      if (document.errors.length || !yaml.isSeq(document.contents))
        throw Error('OPL 插件设置迁移无法读取现有配置，已保留原文件')
      const rows = document.contents.items
      const base = rows.find((row) => yaml.isMap(row) && row.get('id') === 'opl-suite')
      const legacy = base?.get('config', true)
      if (!yaml.isMap(legacy)) return
      let changed = false
      // Permission defaults moved to the official permission settings owner.
      // Preserve an old OPL selection only when the official destination has no
      // explicit value; the runtime never reads or writes the legacy field.
      if (legacy.has('lastPermissionPreset')) {
        let row = rows.find((item) => yaml.isMap(item) && item.get('id') === 'permission')
        if (!row) {
          row = document.createNode({ id: 'permission', config: {} })
          document.contents.add(row)
        }
        let config = row.get('config', true)
        if (!config) {
          config = document.createNode({})
          row.set('config', config)
        }
        if (!yaml.isMap(config)) throw Error('官方权限设置不是映射，已保留原配置')
        if (!config.has('defaultPreset')) {
          const value = legacy.get('lastPermissionPreset', true)
          config.set('defaultPreset', value?.clone ? value.clone() : value)
        }
        legacy.delete('lastPermissionPreset')
        changed = true
      }
      for (const [id, fields] of Object.entries(FIELDS)) {
        if (!fields.some((field) => legacy.has(field))) continue
        let row = rows.find((item) => yaml.isMap(item) && item.get('id') === id)
        if (!row) {
          row = document.createNode({ id, config: {} })
          document.contents.add(row)
        }
        let config = row.get('config', true)
        if (!config) {
          config = document.createNode({})
          row.set('config', config)
        }
        if (!yaml.isMap(config)) throw Error('OPL 插件设置不是映射，已保留原配置')
        for (const field of fields) {
          if (!legacy.has(field)) continue
          if (!config.has(field)) {
            const value = legacy.get(field, true)
            config.set(field, value?.clone ? value.clone() : value)
          }
          legacy.delete(field)
          changed = true
        }
      }
      if (!changed) return
      const backup = join(dir, 'cordis.patch.before-opl-split.yml')
      if (!existsSync(backup)) writeFileSync(backup, original, { mode: 0o600, flag: 'wx' })
      await writeFileAtomic(file, document.toString(), { mode: 0o600 })
    },
    { waitMs: 1000 },
  )
}

/** An update must retain independently disabled packages and the old suite's disabled state. */
function disabledOplPackages(manifest, names) {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const installed = manifest.dependencies ?? {}
  const legacyDisabled =
    Object.hasOwn(installed, '@one-person-lab/dsh-opl') &&
    !bundles.includes('@one-person-lab/dsh-opl')
  return names.filter((name) =>
    Object.hasOwn(installed, name) ? !bundles.includes(name) : legacyDisabled,
  )
}
module.exports = { migrateSplitSettings, disabledOplPackages, FIELDS }
