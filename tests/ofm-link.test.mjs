import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateOfmLink } from '../installer/ofm-upgrade.cjs'
const name = 'dsh-our-free-model'
const dep = `link:ofm/${name}`
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'opl-link-'))
  const pkg = join(dir, 'node_modules', name)
  await mkdir(pkg, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      dependencies: { [name]: `file:vendor/${name}-2.8.3.tgz` },
      dsh: { profile: { bundles: [name] } },
    }),
  )
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version: '2.9.0' }))
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml'])
    await writeFile(join(pkg, file), `official ${file}`)
  await mkdir(join(dir, 'vendor'))
  await writeFile(join(dir, 'vendor', `${name}-2.8.3.tgz`), 'retained archive')
  const calls = []
  const install = async (args) => {
    calls.push(args)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    if (args[0] === 'remove') {
      delete manifest.dependencies[name]
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
      await rm(pkg, { recursive: true, force: true })
      return
    }
    manifest.dependencies[name] = args[1].slice(name.length + 1)
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
    await rm(pkg, { recursive: true, force: true })
    await symlink(join(dir, 'ofm', name), pkg, process.platform === 'win32' ? 'junction' : 'dir')
  }
  try {
    await run({ dir, pkg, calls, install })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
test('migrates complete installed bytes, preserves newer version and configuration, and reinstall leaves the link intact', () =>
  fixture(async ({ dir, pkg, install, calls }) => {
    await writeFile(join(dir, 'cordis.patch.yml'), 'private fixture configuration')
    const result = await migrateOfmLink({ restoreBundles: async () => {}, dir, install })
    assert.equal(result.version, '2.9.0')
    assert.deepEqual(calls, [
      ['remove', name],
      ['add', `${name}@${dep}`],
    ])
    assert.equal(await readFile(join(dir, 'ofm', name, 'client.js'), 'utf8'), 'official client.js')
    assert.equal((await lstat(join(dir, 'ofm', name, 'index.js'))).nlink, 1)
    assert.equal(
      await readFile(join(dir, 'cordis.patch.yml'), 'utf8'),
      'private fixture configuration',
    )
    assert.equal(
      (await migrateOfmLink({ restoreBundles: async () => {}, dir, install })).reason,
      'self-managed-link',
    )
    assert.equal(calls.length, 2)
  }))
test('refuses a live profile before package migration', () =>
  fixture(async ({ dir, install }) => {
    await writeFile(join(dir, 'control.json'), JSON.stringify({ pid: process.pid }))
    await assert.rejects(
      migrateOfmLink({ restoreBundles: async () => {}, dir, install }),
      /停止 profile/,
    )
  }))
test('retains recovery evidence and complete package when pnpm and rollback fail', () =>
  fixture(async ({ dir }) => {
    await assert.rejects(
      migrateOfmLink({
        restoreBundles: async () => {},
        dir,
        install: async () => {
          throw Error('manager unavailable')
        },
      }),
      (error) => error.recovery === 'restored-by-pnpm' || error.recovery === 'backup-retained',
    )
    const state = JSON.parse(await readFile(join(dir, '.ofm-upgrade.json'), 'utf8'))
    assert.equal(state.phase, 'recovery-required')
    assert.equal(await readFile(join(dir, 'ofm', name, 'client.js'), 'utf8'), 'official client.js')
  }))
test('first install extracts the verified complete archive and registers a relative link', () =>
  fixture(async ({ dir, pkg, install }) => {
    const { execFileSync } = await import('node:child_process')
    const { createHash } = await import('node:crypto')
    const source = join(dir, 'release', 'package')
    await mkdir(source, { recursive: true })
    for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'extra-resource.txt'])
      await writeFile(join(source, file), `released ${file}`)
    await writeFile(join(source, 'package.json'), JSON.stringify({ name, version: '2.8.3' }))
    const archive = join(dir, 'release.tgz')
    execFileSync(
      process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar',
      ['-czf', archive, '-C', join(dir, 'release'), 'package'],
    )
    const bytes = await readFile(archive)
    const plugin = {
      name,
      version: '2.8.3',
      source: 'https://example.test/ofm.tgz',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    await rm(join(dir, 'vendor', `${name}-2.8.3.tgz`))
    await writeFile(join(dir, 'package.json'), '{}')
    await rm(pkg, { recursive: true })
    // pnpm registers the dependency without modifying the target package contents.
    const register = async (args) => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: dep } }))
      await symlink(join(dir, 'ofm', name), pkg, process.platform === 'win32' ? 'junction' : 'dir')
      assert.deepEqual(args, ['add', `${name}@${dep}`])
    }
    await migrateOfmLink({
      restoreBundles: async () => {},
      dir,
      install: register,
      plugin,
      fetchImpl: async () => new Response(bytes),
    })
    assert.equal(
      await readFile(join(dir, 'ofm', name, 'extra-resource.txt'), 'utf8'),
      'released extra-resource.txt',
    )
  }))
test('snapshot failure preserves the original error and restores the original dependency without replacing original files', () =>
  fixture(async ({ dir, pkg }) => {
    const original = await readFile(join(dir, 'package.json'), 'utf8')
    await writeFile(join(dir, '.ofm-upgrade-recovery'), 'blocked recovery directory')
    const calls = []
    await assert.rejects(
      migrateOfmLink({
        restoreBundles: async () => {},
        dir,
        install: async (args) => {
          calls.push(args)
        },
      }),
      (error) => {
        assert.equal(error.code, 'ENOTDIR')
        assert.equal(error.recovery, 'restored-by-pnpm')
        return true
      },
    )
    assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), original)
    assert.equal(await readFile(join(pkg, 'client.js'), 'utf8'), 'official client.js')
    assert.equal(calls.length, 1)
  }))
test('rollback removes the failed link before restoring file bytes and restores bundle order', () =>
  fixture(async ({ dir, pkg, install }) => {
    const { cp } = await import('node:fs/promises')
    const calls = []
    const bundles = []
    let failed = false
    const originalDependency = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      .dependencies[name]
    const manager = async (args) => {
      calls.push(args)
      if (args[0] === 'add' && args[1] === `${name}@${originalDependency}`) {
        const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
        manifest.dependencies[name] = originalDependency
        await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
        await cp(join(dir, 'ofm', name), pkg, { recursive: true })
        return
      }
      await install(args)
      if (!failed && args[0] === 'add') {
        failed = true
        throw Error('post-link failure')
      }
    }
    await assert.rejects(
      migrateOfmLink({
        dir,
        install: manager,
        restoreBundles: async (value) => bundles.push(value),
      }),
      (error) => error.recovery === 'restored-by-pnpm',
    )
    assert.deepEqual(
      calls.map((args) => args[0]),
      ['remove', 'add', 'remove', 'add'],
    )
    assert.deepEqual(bundles, [[name]])
    assert.equal((await lstat(pkg)).isSymbolicLink(), false)
    assert.equal(await readFile(join(pkg, 'client.js'), 'utf8'), 'official client.js')
  }))
