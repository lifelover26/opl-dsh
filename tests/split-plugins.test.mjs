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

test('migrates the legacy permission memory into the official settings owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opl-split-permission-test-'))
  const file = join(dir, 'cordis.patch.yml')
  const original = '- id: opl-suite\n  config:\n    lastPermissionPreset: danger-full-access\n'
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
    const doc = yaml.parse(await readFile(file, 'utf8'), { logLevel: 'silent' })
    assert.deepEqual(doc.find((row) => row.id === 'opl-suite').config, {})
    assert.equal(doc.find((row) => row.id === 'permission').config.defaultPreset, 'danger-full-access')
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
