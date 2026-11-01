/** Use the installed official release's shared, locked package operations. */
const { join, resolve, delimiter } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { mkdirSync, writeFileSync, existsSync } = require('node:fs')
const { installModelPlugins, preserveModelPlugins } = require('./model-plugins.cjs')
const { officialPnpm } = require('./official-pnpm.cjs')
const [application, home, archive, companion] = process.argv.slice(2)
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
  const { initProfile, PROFILE_TEMPLATES } = await load('@deepseek-ai/dsh-app-boot')
  const { runPluginCommand } = await load('@deepseek-ai/dsh-plugin-manager/operations')
  const dir = join(home, 'profiles/desktop')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  initProfile(dir, PROFILE_TEMPLATES.web.bundles)
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
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
