import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as yaml from 'yaml'
import split from '../installer/split-plugins.cjs'

test('split settings preserve expressions, unknown fields and explicit destination overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opl-split-test-'))
  const file = join(dir, 'cordis.patch.yml')
  const original =
    '- id: opl-suite\n  config:\n    gateway: {apiKeyEnv: PRIVATE_REF}\n    executionLimits: {idleProgressMs: 42000}\n    roleExecutions: {developer: combination-a}\n    wakeExecutable: !!js process.env.OPL_TEST_EXECUTABLE\n    customField: keep\n- id: opl-collaboration\n  config:\n    roleExecutions: {developer: combination-b}\n'
  await writeFile(file, original)
  let stopped = 0
  const options = {
    dir,
    yaml,
    withFileLock: async (_file, operation) => operation(),
    writeFileAtomic: writeFile,
    stopped: async () => {
      stopped++
    },
  }
  try {
    await split.migrateSplitSettings(options)
    const bytes = await readFile(file, 'utf8')
    const doc = yaml.parse(bytes, { logLevel: 'silent' })
    assert.deepEqual(doc.find((row) => row.id === 'opl-suite').config, {
      gateway: { apiKeyEnv: 'PRIVATE_REF' },
      customField: 'keep',
    })
    assert.equal(
      doc.find((row) => row.id === 'opl-execution').config.executionLimits.idleProgressMs,
      42000,
    )
    assert.equal(
      doc.find((row) => row.id === 'opl-collaboration').config.roleExecutions.developer,
      'combination-b',
    )
    assert.match(bytes, /!!js process.env.OPL_TEST_EXECUTABLE/)
    assert.equal(await readFile(join(dir, 'cordis.patch.before-opl-split.yml'), 'utf8'), original)
    await split.migrateSplitSettings(options)
    assert.equal(await readFile(file, 'utf8'), bytes)
    assert.equal(stopped, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const permissionMigrations = [
  {
    name: 'moves the split execution default even without an opl-suite row',
    original: '- id: opl-execution\n  config:\n    lastPermissionPreset: read-only\n',
    expected: [
      { id: 'opl-execution', config: {} },
      { id: 'permission', config: { defaultPreset: 'read-only' } },
    ],
  },
  {
    name: 'migrates an old monolithic settings row',
    original: '- id: opl-suite\n  config:\n    lastPermissionPreset: workspace-write\n',
    expected: [
      { id: 'opl-suite', config: {} },
      { id: 'permission', config: { defaultPreset: 'workspace-write' } },
    ],
  },
  {
    name: 'preserves a user-set official default amid both old settings rows',
    original:
      '- id: opl-suite\n  config:\n    lastPermissionPreset: workspace-write\n- id: opl-execution\n  config:\n    lastPermissionPreset: danger-full-access\n    rememberPermissionPreset: false\n- id: permission\n  config:\n    defaultPreset: read-only\n',
    expected: [
      { id: 'opl-suite', config: {} },
      { id: 'opl-execution', config: { rememberPermissionPreset: false } },
      { id: 'permission', config: { defaultPreset: 'read-only' } },
    ],
  },
  {
    name: 'never passes an invalid legacy preset into the official permission service',
    original: '- id: opl-execution\n  config:\n    lastPermissionPreset: auto\n',
    expected: [{ id: 'opl-execution', config: { lastPermissionPreset: 'auto' } }],
  },
]

for (const { name, original, expected } of permissionMigrations)
  test(name, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opl-split-permission-test-'))
    const file = join(dir, 'cordis.patch.yml')
    await writeFile(file, original)
    const options = {
      dir,
      yaml,
      withFileLock: async (_file, operation) => operation(),
      writeFileAtomic: writeFile,
      stopped: async () => {},
    }
    try {
      await split.migrateSplitSettings(options)
      const migrated = await readFile(file, 'utf8')
      assert.deepEqual(yaml.parse(migrated, { logLevel: 'silent' }), expected)
      await split.migrateSplitSettings(options)
      assert.equal(await readFile(file, 'utf8'), migrated)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

test('split updates retain independent and legacy disabled choices', () => {
  const names = [
    '@one-person-lab/dsh-opl',
    '@one-person-lab/dsh-execution',
    '@one-person-lab/dsh-collaboration',
  ]
  assert.deepEqual(
    split.disabledOplPackages(
      { dependencies: { [names[0]]: 'old' }, dsh: { profile: { bundles: [] } } },
      names,
    ),
    names,
  )
  assert.deepEqual(
    split.disabledOplPackages(
      {
        dependencies: Object.fromEntries(names.map((name) => [name, 'old'])),
        dsh: { profile: { bundles: [names[0], names[1]] } },
      },
      names,
    ),
    [names[2]],
  )
})
