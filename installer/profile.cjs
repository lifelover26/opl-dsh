/** Use the installed official release's shared, locked package operations. */
const { join, resolve, delimiter } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { installModelPlugins, preserveModelPlugins } = require('./model-plugins.cjs')
const { officialPnpm } = require('./official-pnpm.cjs')
const [application, home, archive, ...options] = process.argv.slice(2)
const companion = options.find((option) => !option.startsWith('--'))
const flags = options.filter((option) => option.startsWith('--'))
const plugins = flags
  .filter((flag) => flag.startsWith('--plugin='))
  .map((flag) => resolve(flag.slice(9)))
const teamBundle = '@deepseek-ai/dsh-experimental-agent-team-profile'
const cliProfile = process.env.OPL_DSH_CLI_PROFILE
if (
  cliProfile !== undefined &&
  (!/^[a-z][a-z0-9-]*$/u.test(cliProfile) || cliProfile === 'desktop')
)
  throw new Error('CLI profile 名称无效')
const profileName = cliProfile ?? 'desktop'
async function main() {
  const resources = cliProfile
    ? undefined
    : process.platform === 'win32'
      ? join(application, 'resources')
      : join(application, 'Contents/Resources')
  const runtime = cliProfile ? application : join(resources, 'app.asar/dsh')
  const pnpm = cliProfile ? 'pnpm' : officialPnpm(resources)
  const requireRuntime = createRequire(join(runtime, 'package.json'))
  const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href)
  const official = JSON.parse(
    readFileSync(requireRuntime.resolve('@deepseek-ai/dsh/package.json'), 'utf8'),
  )
  const retiredTeam = !official.dependencies?.[teamBundle]
  if (
    retiredTeam &&
    !(await load('@deepseek-ai/dsh-official-bundles')).RETIRED_BUNDLES?.has(teamBundle)
  )
    throw new Error('官方桌面缺少 Team 插件且未声明迁移，未改动插件选择')
  const officialBundles = retiredTeam ? [] : [teamBundle]
  process.env.DSH_HOME = home
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const { initProfile } = boot
  const templates =
    boot.PROFILE_TEMPLATES ?? (await load('@deepseek-ai/dsh-official-bundles')).PROFILE_TEMPLATES
  const { runPluginCommand } = await load('@deepseek-ai/dsh-plugin-manager/operations')
  const dir = join(home, 'profiles', profileName)
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
        profile: profileName,
        dir,
        installAnchor: requireRuntime.resolve('@deepseek-ai/dsh/package.json'),
        cwd: process.cwd(),
      },
      args,
      {
        ...(cliProfile
          ? { command: pnpm }
          : {
              command: process.execPath,
              args: ['--expose-internals', pnpm],
              env: {
                ELECTRON_RUN_AS_NODE: '1',
                PATH: join(resources, 'runtime/bin') + delimiter + process.env.PATH,
              },
            }),
        execution: cliProfile ? 'cli' : 'service',
        outputBytes: 8192,
        lockWaitMs: 1000,
        idleTimeoutMs: 120000,
        onOutput: (text) => process.stdout.write(text),
      },
    )
    if (result.exitCode !== 0) throw new Error('Plugin installation failed')
  }
  const restoreBundles = async (bundles) => {
    const { withFileLock } = await load('@deepseek-ai/dsh-atomic-write')
    const { stopped } = require('./ofm-owner.cjs')
    await withFileLock(
      join(dir, 'package.json'),
      async () => {
        await stopped(dir)
        const manifest = boot.readProfileManifest('dsh', dir)
        boot.writeProfileBundles(dir, manifest, bundles)
      },
      { waitMs: 1000 },
    )
  }
  if ([archive, companion, ...flags].includes('--ofm-upgrade')) {
    // Register the independent OFM directory through the official profile operations.
    const { MODEL_PLUGINS } = require('./model-plugins.cjs')
    const { migrateOfmLink } = require('./ofm-upgrade.cjs')
    const result = await migrateOfmLink({ dir, install, restoreBundles, plugin: MODEL_PLUGINS[0] })
    process.stdout.write(JSON.stringify(result) + '\n')
    return
  }
  const { disabledOplPackages, migrateSplitSettings } = require('./split-plugins.cjs')
  const names = [
    '@one-person-lab/dsh-opl',
    ...plugins.map((_, index) =>
      index === 0 ? '@one-person-lab/dsh-execution' : '@one-person-lab/dsh-collaboration',
    ),
  ]
  if (plugins.length && plugins.length !== 2) throw Error('OPL 多插件安装清单不完整')
  const manifestBefore = boot.readProfileManifest('dsh', dir)
  const disabled = disabledOplPackages(manifestBefore, names)
  await preserveModelPlugins({ dir, install: () => install(['add', resolve(archive), ...plugins]) })
  if (disabled.length) {
    const manifest = boot.readProfileManifest('dsh', dir)
    await restoreBundles(
      (manifest.dsh?.profile?.bundles ?? []).filter((name) => !disabled.includes(name)),
    )
  }
  const orderedManifest = boot.readProfileManifest('dsh', dir)
  const currentBundles = orderedManifest.dsh?.profile?.bundles ?? []
  const oplOrder = names.filter((name) => currentBundles.includes(name))
  if (oplOrder.length > 1) {
    const first = currentBundles.findIndex((name) => names.includes(name))
    const remaining = currentBundles.filter((name) => !names.includes(name))
    const next = [...remaining.slice(0, first), ...oplOrder, ...remaining.slice(first)]
    if (JSON.stringify(next) !== JSON.stringify(currentBundles))
      boot.writeProfileBundles(dir, orderedManifest, next)
  }
  if (plugins.length) {
    const { withFileLock, writeFileAtomic } = await load('@deepseek-ai/dsh-atomic-write')
    await migrateSplitSettings({
      dir,
      yaml: requireRuntime('yaml'),
      withFileLock,
      writeFileAtomic,
      stopped: require('./ofm-owner.cjs').stopped,
    })
  }
  await installModelPlugins({ dir, install, restoreBundles })
  const { releaseOfmManaged } = require('./ofm-owner.cjs')
  await releaseOfmManaged({
    dir,
    home,
    installAnchor: requireRuntime.resolve('@deepseek-ai/dsh/package.json'),
    load,
  })
  if (companion) await install(['add', resolve(companion)])
  // Select the shipped official layers once. Their plugin-manager switches own
  // later enablement; a suite repair must not undo the person's disabled choice.
  const receipt = join(dir, 'opl-official-bundles.json')
  const { withFileLock } = await load('@deepseek-ai/dsh-atomic-write')
  await withFileLock(
    join(dir, 'package.json'),
    async () => {
      // The official profile loader removes its retired bundle references before
      // the previous suite receipt can skip the optional-bundle migration.
      if (retiredTeam) {
        await require('./ofm-owner.cjs').stopped(dir)
        boot.loadProfileDirectory(
          'dsh',
          dir,
          requireRuntime.resolve('@deepseek-ai/dsh/package.json'),
          { userLayer: false },
        )
      }
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
