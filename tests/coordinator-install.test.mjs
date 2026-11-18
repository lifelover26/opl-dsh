/** Exercise coordinator resource upgrades and integrity checks in private installer fixtures. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkill, verifySkill } from '../installer/skill-install.mjs'

const modules = ['state', 'hooks', 'feedback', 'process', 'runtime', 'cli', 'dispatch-registration']
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'opl-coordinator-install-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const release = join(base, 'release'),
    codexHome = join(base, 'codex')
  mkdirSync(join(release, 'skill'), { recursive: true })
  for (const file of ['SKILL.md', 'control.mjs', 'harness-mcp.mjs', 'windows-acl.mjs'])
    writeFileSync(join(release, 'skill', file), `original ${file}\n`)
  writeFileSync(join(release, 'windows-lifecycle.mjs'), 'export {}\n')
  const options = {
    release,
    codexHome,
    executable: join(base, 'app'),
    home: join(base, 'profile'),
    launcher: join(base, 'launcher'),
    root: join(base, 'suite'),
  }
  const addCoordinator = () => {
    mkdirSync(join(release, 'skill/coordinator'), { recursive: true })
    for (const name of modules)
      writeFileSync(
        join(release, 'skill/coordinator', name + '.mjs'),
        `export const name = '${name}'\n`,
      )
  }
  return { base, options, addCoordinator }
}

test('an older managed Skill upgrades missing coordinator files and retains configuration and ledger', (t) => {
  const { options, addCoordinator } = fixture(t)
  const directory = installSkill(options)
  const config = readFileSync(join(directory, 'config.json'), 'utf8')
  const ledger = JSON.parse(config).ledger
  mkdirSync(ledger, { recursive: true })
  writeFileSync(join(ledger, 'existing-operation.json'), '{"accepted":true}\n')
  const oldManifest = JSON.parse(readFileSync(join(directory, '.opl-install.json'), 'utf8'))
  assert.equal(
    Object.keys(oldManifest.files).some((file) => file.startsWith('coordinator/')),
    false,
  )

  addCoordinator()
  assert.equal(installSkill(options), directory)
  assert.equal(readFileSync(join(directory, 'config.json'), 'utf8'), config)
  assert.equal(readFileSync(join(ledger, 'existing-operation.json'), 'utf8'), '{"accepted":true}\n')
  const manifest = JSON.parse(readFileSync(join(directory, '.opl-install.json'), 'utf8'))
  for (const name of modules) {
    const file = `coordinator/${name}.mjs`
    assert.equal(manifest.files[file], digest(readFileSync(join(directory, file))))
  }
  const backups = readdirSync(join(options.codexHome, 'skill-backups'))
  assert.equal(backups.length, 1)
  assert.deepEqual(readdirSync(join(options.codexHome, 'skills')), ['opl-dsh-official'])
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        join(options.codexHome, 'skill-backups', backups[0], '.opl-install.json'),
        'utf8',
      ),
    ),
    oldManifest,
  )
  assert.doesNotThrow(() => verifySkill(directory))
  assert.equal(installSkill(options), directory)
  assert.equal(readdirSync(join(options.codexHome, 'skill-backups')).length, 1)
})

test('every installed coordinator module is protected against edits and deletion', async (t) => {
  for (const name of modules) {
    await t.test(name, (t) => {
      const { options, addCoordinator } = fixture(t)
      addCoordinator()
      const directory = installSkill(options),
        file = join(directory, 'coordinator', name + '.mjs')
      writeFileSync(file, 'local customization\n')
      assert.throws(() => installSkill(options), /手动修改/)
      assert.equal(readFileSync(file, 'utf8'), 'local customization\n')
      rmSync(file)
      assert.throws(() => verifySkill(directory), /手动修改/)
    })
  }
})

test('Linux Skill installation stores the selected profile without installing Codex Hooks', (t) => {
  const { options, addCoordinator } = fixture(t)
  addCoordinator()
  const directory = installSkill({ ...options, profile: 'opl-linux' })
  const installed = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
  assert.equal(installed.profile, 'opl-linux')
  assert.deepEqual(readdirSync(options.codexHome), ['skills'])
  assert.doesNotThrow(() => verifySkill(directory))
})

test('unmanaged nested coordinator files are preserved by refusing replacement', (t) => {
  const { options, addCoordinator } = fixture(t)
  addCoordinator()
  const directory = installSkill(options),
    file = join(directory, 'coordinator', 'local-settings.json')
  writeFileSync(file, '{"custom":true}\n')
  assert.throws(() => installSkill(options), /手动修改/)
  assert.equal(readFileSync(file, 'utf8'), '{"custom":true}\n')
})
