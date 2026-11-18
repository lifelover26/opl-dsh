import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'yaml'
const require = createRequire(import.meta.url)
const {
  applyPendingNativeShell,
  runPendingNativeShell,
} = require('../installer/native-shell-pending.cjs')
const expr = (source) => ({ __jsExpr: source })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'opl-shell-pending-'))
  const base = [
    ...[
      ['bash-sandbox', '@deepseek-ai/dsh-bash-sandbox', true, expr('windows')],
      ['pwsh-sandbox', '@deepseek-ai/dsh-pwsh-sandbox', true, expr('posix')],
      ['opl-native-git-bash', '@one-person-lab/dsh-opl/git-bash', false, true],
    ].map(([id, name, _after, disabled]) => ({ id, name, disabled })),
    ...['standard', 'cordis', 'ptc'].map((id) => ({
      id: 'preset-' + id,
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id,
        keep: true,
        plugins: [
          { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: expr('windows') },
          { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: expr('posix') },
          { id: 'other', name: 'other', config: { keep: 'yes' } },
        ],
      },
    })),
  ]
  const entries = base.map((row) => ({
    id: row.id,
    name: row.name,
    preset: row.id.startsWith('preset-'),
    before: row.config
      ? row.config.plugins.slice(0, 2).map((tool) => tool.disabled)
      : [row.disabled],
    after: row.config ? [false, true] : [row.id !== 'opl-native-git-bash'],
  }))
  const receipt = { pending: true, enabled: true, entries }
  const file = join(dir, 'cordis.patch.yml')
  await writeFile(
    file,
    yaml.stringify([
      { id: 'opl-suite', config: { nativeShellReceipt: JSON.stringify(receipt), other: 'keep' } },
    ]),
  )
  const compose = async () => {
    const all = structuredClone([
      ...base,
      { id: 'opl-suite', name: '@one-person-lab/dsh-opl', config: {} },
    ])
    for (const patch of yaml.parse(await readFile(file, 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => ({ __jsExpr: value }) }],
    }))
      Object.assign(
        all.find((row) => row.id === patch.id),
        patch,
      )
    return all
  }
  const options = {
    dir,
    yaml,
    compose,
    withFileLock: async (_file, work) => work(),
    writeFileAtomic: writeFile,
  }
  const apply = () => applyPendingNativeShell(options)
  const safeApply = () => runPendingNativeShell(options)
  return { dir, base, entries, compose, apply, safeApply, file }
}
test('applies the saved choice before launch and restores exact source values on the next restart', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.apply()).changed, true)
    const on = await f.compose()
    assert.equal(on.find((row) => row.id === 'pwsh-sandbox').disabled, true)
    assert.equal(on.find((row) => row.id === 'opl-native-git-bash').disabled, false)
    const preset = on.find((row) => row.id === 'preset-standard')
    assert.deepEqual(
      preset.config.plugins.slice(0, 2).map((tool) => tool.disabled),
      [false, true],
    )
    assert.deepEqual(
      preset.config.plugins[2],
      f.base.find((row) => row.id === preset.id).config.plugins[2],
    )
    const doc = yaml.parse(await readFile(f.file, 'utf8'))
    doc.push({
      id: 'opl-suite',
      config: {
        nativeShellReceipt: JSON.stringify({ pending: true, enabled: false, entries: f.entries }),
        other: 'user edit',
      },
    })
    await writeFile(f.file, yaml.stringify(doc))
    assert.equal((await f.apply()).changed, true)
    const off = await f.compose()
    for (const original of f.base)
      assert.deepEqual(
        off.find((row) => row.id === original.id),
        original,
      )
    assert.equal(off.find((row) => row.id === 'opl-suite').config.other, 'user edit')
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
test('refuses a source edit after the choice was saved without writing any bytes', async () => {
  const f = await fixture()
  try {
    const doc = yaml.parse(await readFile(f.file, 'utf8'))
    doc.push({ id: 'pwsh-sandbox', disabled: false })
    await writeFile(f.file, yaml.stringify(doc))
    const before = await readFile(f.file, 'utf8')
    const result = await f.safeApply()
    assert.equal(result.failed, true)
    assert.match(result.message, /用户修改/)
    assert.equal(await readFile(f.file, 'utf8'), before)
    const status = JSON.parse(await readFile(join(f.dir, 'native-shell-status.json'), 'utf8'))
    assert.match(status.message, /用户修改/)
    assert.match(status.receiptHash, /^[0-9a-f]{64}$/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
test('repeated shell toggles retain a single config owner and allow later native setting edits', async () => {
  const f = await fixture()
  try {
    const old = yaml.parse(await readFile(f.file, 'utf8'))
    const receipt = old[0].config.nativeShellReceipt
    old.push({ id: 'opl-suite', config: { nativeShellReceipt: receipt, other: 'older snapshot' } })
    old.push({
      id: 'opl-suite',
      config: { nativeShellReceipt: receipt, other: 'current user edit' },
    })
    await writeFile(f.file, yaml.stringify(old))
    for (const enabled of [true, false, true, false]) {
      const before = yaml.parseDocument(await readFile(f.file, 'utf8'))
      const owner = before.contents.items.findLast(
        (row) => yaml.isMap(row) && row.get('id') === 'opl-suite',
      )
      const config = owner.get('config', true)
      config.set(
        'nativeShellReceipt',
        JSON.stringify({ pending: true, enabled, entries: f.entries }),
      )
      config.set('updatePolicyChosen', !enabled)
      await writeFile(f.file, String(before))
      await f.apply()
      const text = await readFile(f.file, 'utf8')
      const document = yaml.parseDocument(text)
      const owners = document.contents.items.filter(
        (row) => yaml.isMap(row) && row.get('id') === 'opl-suite' && row.has('config'),
      )
      assert.equal(owners.length, 1)
      assert.equal(owners[0].get('config', true).get('other'), 'current user edit')
      assert.equal(owners[0].get('config', true).get('updatePolicyChosen'), !enabled)
    }
    const { load } = await import('js-yaml')
    const { entryListSchema } = await import('@deepseek-ai/cordis-plugin-include')
    const patches = load(await readFile(f.file, 'utf8'), { schema: entryListSchema })
    const preset = patches.findLast((row) => row.id === 'preset-standard' && row.config)
    assert.deepEqual(preset.config.plugins[0].disabled, expr('windows'))
    assert.deepEqual(preset.config.plugins[1].disabled, expr('posix'))
    assert.match(await readFile(f.file, 'utf8'), /!!js/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
