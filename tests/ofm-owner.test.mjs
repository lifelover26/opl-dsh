import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { releaseOfmManaged } from '../installer/ofm-owner.cjs'
const require = createRequire(import.meta.url)
const load = (name) => import(pathToFileURL(require.resolve(name)).href)
const name = 'dsh-our-free-model'
async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'opl-ofm-owner-'))
  const dir = join(home, 'profiles', 'desktop')
  const pkg = join(dir, 'node_modules', name)
  const installAnchor = join(home, 'official', 'package.json')
  await mkdir(pkg, { recursive: true })
  await mkdir(join(home, 'official'))
  await writeFile(
    installAnchor,
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }),
  )
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: { [name]: 'file:vendor/ofm.tgz' },
      dsh: { profile: { bundles: [name] } },
    }),
  )
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name, version: '2.8.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
  await writeFile(
    join(pkg, 'cordis.patch.yml'),
    '- insert:\n    - id: our-free-model\n      name: dsh-our-free-model\n      config: {}\n',
  )
  await writeFile(
    join(dir, 'pnpm-lock.yaml'),
    'lockfileVersion: "9.0"\nimporters:\n  .:\n    dependencies:\n      dsh-our-free-model:\n        specifier: file:vendor/ofm.tgz\n        version: file:vendor/ofm.tgz\n',
  )
  const path = join(dir, 'cordis.patch.yml')
  await writeFile(path, '[]\n')
  try {
    await run({
      home,
      dir,
      path,
      installAnchor,
      load,
      apply: () => releaseOfmManaged({ dir, home, installAnchor, load }),
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
test('release preserves unreceipted managed settings and removes only the precisely receipted override', () =>
  fixture(async (f) => {
    const { releaseOfmManaged } = await import('../installer/ofm-owner.cjs')
    const { createHash } = await import('node:crypto')
    const { symlink } = await import('node:fs/promises')
    const target = join(f.dir, 'ofm', name)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({ name, version: '2.8.3' }))
    await rm(join(f.dir, 'node_modules', name), { recursive: true })
    await symlink(
      target,
      join(f.dir, 'node_modules', name),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const manifest = JSON.parse(await readFile(join(f.dir, 'package.json'), 'utf8'))
    manifest.dependencies[name] = `link:ofm/${name}`
    await writeFile(join(f.dir, 'package.json'), JSON.stringify(manifest))
    const text =
      '- id: our-free-model\n  config:\n    distribution: managed\n    proxy: !!js process.env.TEST_PROXY\n    keep: true\n'
    await writeFile(f.path, text)
    const release = () => releaseOfmManaged({ dir: f.dir, load })
    assert.equal((await release()).reason, 'no-owned-override')
    assert.equal(await readFile(f.path, 'utf8'), text)
    const receipt = join(f.dir, 'opl-ofm-managed.json')
    await writeFile(receipt, JSON.stringify({ schemaVersion: 1, patchSha256: 'invalid' }))
    assert.equal((await release()).reason, 'owned-override-changed')
    await writeFile(
      receipt,
      JSON.stringify({
        schemaVersion: 1,
        patchSha256: createHash('sha256').update(text).digest('hex'),
      }),
    )
    assert.equal((await release()).changed, true)
    assert.match(await readFile(f.path, 'utf8'), /!!js process.env.TEST_PROXY/)
    assert.doesNotMatch(await readFile(f.path, 'utf8'), /distribution/)
    assert.match(await readFile(f.path, 'utf8'), /keep: true/)
  }))
