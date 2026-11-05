import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const installer = fileURLToPath(new URL('../installer/profile.cjs', import.meta.url))
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

async function runtime(t, owner, existing) {
  const root = await mkdtemp(join(tmpdir(), 'opl-profile-template-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const app = join(root, 'official')
  const resources =
    process.platform === 'win32' ? join(app, 'resources') : join(app, 'Contents/Resources')
  const runtime = join(resources, 'app.asar/dsh')
  const payload = join(root, 'payload')
  const home = join(root, 'home')
  const profile = join(home, 'profiles/desktop')
  await mkdir(runtime, { recursive: true })
  await mkdir(payload)
  await writeFile(join(runtime, 'package.json'), '{"type":"module"}\n')
  await copyFile(installer, join(payload, 'profile.cjs'))
  await writeFile(
    join(payload, 'model-plugins.cjs'),
    'exports.preserveModelPlugins = ({ install }) => install();\n' +
      'exports.installModelPlugins = async () => {};\n',
  )
  await writeFile(join(payload, 'official-pnpm.cjs'), 'exports.officialPnpm = () => "pnpm.cjs";\n')
  async function module(name, exports, source) {
    const dir = join(runtime, 'node_modules', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports }))
    await writeFile(join(dir, 'index.mjs'), source)
  }
  const template = `export const PROFILE_TEMPLATES = { web: { bundles: ${JSON.stringify(bundles)} } };\n`
  await module(
    '@deepseek-ai/dsh-app-boot',
    './index.mjs',
    `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function initProfile(dir, bundles) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ dsh: { profile: { bundles } } }));
  writeFileSync(join(dir, 'template-observation.json'), JSON.stringify(bundles));
}
${owner === 'app-boot' ? template : ''}`,
  )
  if (owner === 'official-bundles')
    await module('@deepseek-ai/dsh-official-bundles', './index.mjs', template)
  await module(
    '@deepseek-ai/dsh-plugin-manager',
    { './operations': './index.mjs' },
    `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function runPluginCommand(profile, args) {
  writeFileSync(join(profile.dir, 'install-observation.json'), JSON.stringify({ profile: profile.profile, args }));
  return { exitCode: 0 };
}`,
  )
  await module('@deepseek-ai/dsh', { './package.json': './package.json' }, '')
  if (existing) {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify(existing))
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
    delete env[key]
  const archive = join(root, 'owned-enhancement.tgz')
  await run(process.execPath, [join(payload, 'profile.cjs'), app, home, archive], {
    env,
    timeout: 30000,
    windowsHide: true,
  })
  return {
    manifest: JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')),
    template: JSON.parse(await readFile(join(profile, 'template-observation.json'), 'utf8')),
    install: JSON.parse(await readFile(join(profile, 'install-observation.json'), 'utf8')),
    archive,
  }
}

for (const owner of ['app-boot', 'official-bundles'])
  test(`profile installation reads the official web template from ${owner}`, async (t) => {
    const result = await runtime(t, owner)
    assert.deepEqual(result.template, bundles)
    assert.deepEqual(result.manifest.dsh.profile.bundles, bundles)
    assert.deepEqual(result.install, { profile: 'desktop', args: ['add', result.archive] })
  })

test('the moved template leaves an existing profile manifest intact', async (t) => {
  const existing = {
    dependencies: { 'personal-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['personal-bundle'] } },
  }
  const result = await runtime(t, 'official-bundles', existing)
  assert.deepEqual(result.manifest, existing)
  assert.deepEqual(result.install.args, ['add', result.archive])
})
