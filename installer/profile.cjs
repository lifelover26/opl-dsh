/** Use the installed official release's shared, locked package operations. */
const { join, resolve, delimiter } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { installModelPlugins, preserveModelPlugins } = require('./model-plugins.cjs')
const { officialPnpm } = require('./official-pnpm.cjs')
const [application, home, archive, companion] = process.argv.slice(2)
const officialBundles = [
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-auto-review',
]
async function main() {
  const resources =
    process.platform === 'win32'
      ? join(application, 'resources')
      : join(application, 'Contents/Resources')
  const runtime = join(resources, 'app.asar/dsh')
  const pnpm = officialPnpm(resources)
  const requireRuntime = createRequire(join(runtime, 'package.json'))
  const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href)
  process.env.DSH_HOME = home
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const { initProfile } = boot
  const templates =
    boot.PROFILE_TEMPLATES ?? (await load('@deepseek-ai/dsh-official-bundles')).PROFILE_TEMPLATES
  const { runPluginCommand } = await load('@deepseek-ai/dsh-plugin-manager/operations')
  const dir = join(home, 'profiles/desktop')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  initProfile(dir, templates.web.bundles)
  const workspace = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace))
    writeFileSync(workspace, 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n', {
      mode: 0o600,
      flag: 'wx',
    })
  const install = async (args) => {
    const result = await runPluginCommand(
      {
        profile: 'desktop',
        dir,
        installAnchor: requireRuntime.resolve('@deepseek-ai/dsh/package.json'),
        cwd: process.cwd(),
      },
      args,
      {
        command: process.execPath,
        args: ['--expose-internals', pnpm],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          PATH: join(resources, 'runtime/bin') + delimiter + process.env.PATH,
        },
        execution: 'service',
        outputBytes: 8192,
        lockWaitMs: 1000,
        idleTimeoutMs: 120000,
        onOutput: (text) => process.stdout.write(text),
      },
    )
    if (result.exitCode !== 0) throw new Error('Plugin installation failed')
  }
  await preserveModelPlugins({ dir, install: () => install(['add', resolve(archive)]) })
  await installModelPlugins({ dir, install })
  if (companion) await install(['add', resolve(companion)])
  // Select the shipped official layers once. Their plugin-manager switches own
  // later enablement; a suite repair must not undo the person's disabled choice.
  const receipt = join(dir, 'opl-official-bundles.json')
  const { withFileLock } = await load('@deepseek-ai/dsh-atomic-write')
  await withFileLock(
    join(dir, 'package.json'),
    async () => {
      if (existsSync(receipt)) {
        const saved = JSON.parse(readFileSync(receipt, 'utf8'))
        if (
          saved.schemaVersion !== 1 ||
          !officialBundles.every((bundle) => saved.bundles?.includes(bundle))
        )
          throw new Error('官方插件迁移回执无效，已保留现有配置')
        return
      }
      const manifest = boot.readProfileManifest('dsh', dir)
      const bundles = manifest.dsh?.profile?.bundles ?? []
      // A custom profile without the official base cannot host Agent Teams.
      if (!bundles.includes('@deepseek-ai/dsh-base')) return
      const official = JSON.parse(
        readFileSync(requireRuntime.resolve('@deepseek-ai/dsh/package.json'), 'utf8'),
      )
      for (const bundle of officialBundles) {
        const metadata = JSON.parse(
          readFileSync(requireRuntime.resolve(bundle + '/package.json'), 'utf8'),
        )
        if (
          official.dependencies?.[bundle] !== official.version ||
          metadata.version !== official.version
        )
          throw new Error('官方插件与桌面版本不一致，未改动插件选择：' + bundle)
        if (!metadata.dsh?.bundle?.patch)
          throw new Error('官方插件缺少 bundle 声明，未改动插件选择：' + bundle)
      }
      const next = bundles.filter((bundle) => !officialBundles.includes(bundle))
      const suite = next.indexOf('@one-person-lab/dsh-opl')
      const preservedDisabled = officialBundles.filter(
        (bundle) => Object.hasOwn(manifest.dependencies ?? {}, bundle) && !bundles.includes(bundle),
      )
      next.splice(
        suite < 0 ? next.length : suite,
        0,
        ...officialBundles.filter((bundle) => !preservedDisabled.includes(bundle)),
      )
      if (JSON.stringify(next) !== JSON.stringify(bundles))
        boot.writeProfileBundles(dir, manifest, next)
      writeFileSync(
        receipt,
        JSON.stringify(
          {
            schemaVersion: 1,
            bundles: officialBundles,
            preservedDisabled,
            officialVersion: official.version,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600, flag: 'wx' },
      )
    },
    { waitMs: 1000 },
  )
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
