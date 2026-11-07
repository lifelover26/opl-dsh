/** Build a self-contained enhancement tarball; DSH services stay runtime peers. */
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { generateRpc } from './scripts/generate-rpc.mjs'
import { buildNativeBridge } from './scripts/build-native-bridge.mjs'
import { buildSuperagent } from './scripts/build-superagent.mjs'
const root = import.meta.dirname
const output = process.env.OPL_DIST_DIR ? resolve(process.env.OPL_DIST_DIR) : join(root, 'dist')
const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = project.version
const suiteVersionDefine = {
  __OPL_SUITE_VERSION__: JSON.stringify(version),
}

/** Let Node write esbuild output so Windows endpoint policy cannot block the helper executable. */
async function bundle(options) {
  const result = await build({ ...options, write: false })
  for (const file of result.outputFiles ?? []) await writeFile(file.path, file.contents)
  return result
}
await generateRpc({ root })
await rm(join(output, 'package'), { recursive: true, force: true })
await mkdir(join(output, 'package/lib'), { recursive: true })
const hostBuild = await bundle({
  metafile: true,
  entryPoints: [join(root, 'src/suite/host.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  external: ['@deepseek-ai/*'],
  define: suiteVersionDefine,
  tsconfig: join(root, 'tsconfig.host.json'),
  outfile: join(output, 'package/lib/index.js'),
})
await buildNativeBridge(root, output)
for (const [directory, name] of [
  ['step', 'step-bridge'],
  ['pi', 'pi-bridge'],
  ['kimi', 'kimi-error-bridge'],
  ['zcode-ofm', 'zcode-ofm-bridge'],
  ['.', 'chat-tool-bridge'],
]) {
  await bundle({
    entryPoints: [join(root, `src/execution/host/adapters/${directory}/${name}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: join(output, `package/lib/${name}.mjs`),
  })
}
for (const name of ['muse-bridge.mjs', 'muse-bash-mcp.mjs', 'muse-endpoint.mjs'])
  await cp(join(root, 'src/execution/host/adapters/muse', name), join(output, 'package/lib', name))
/** The official client loader materializes the protocol root, not its pure remote-info leaf. */
const officialClientRuntime = {
  name: 'official-client-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
      args.path === '@deepseek-ai/dsh-typert-protocol/remote-info'
        ? undefined
        : { path: args.path, external: true },
    )
  },
}
const clientBuild = await bundle({
  metafile: true,
  entryPoints: [join(root, 'src/suite/client.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  outfile: join(output, 'client.cjs'),
  external: ['react', 'react/*'],
  plugins: [officialClientRuntime],
  loader: { '.css': 'local-css', '.png': 'dataurl' },
  tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
})
const client = await readFile(join(output, 'client.cjs'), 'utf8')
const css = await readFile(join(output, 'client.css'), 'utf8')
await writeFile(
  join(output, 'package/lib/client.js'),
  `window.__ModuleLoader__.load({id:"@one-person-lab/dsh-opl",factory:(require)=>{const module={exports:{}};const exports=module.exports;${client}\nconst original=module.exports;return {...original,apply(ctx,...args){ctx.effect(()=>{const style=document.createElement('style');style.dataset.oplSuite='';style.textContent=${JSON.stringify(css)};document.head.append(style);return ()=>style.remove()});return original.apply(ctx,...args)}};}});\n`,
)
await cp(join(root, 'src/generated/host.mjs'), join(output, 'package/lib/typert.host.js'))
const externalImports = [
  ...Object.values(hostBuild.metafile.outputs),
  ...Object.values(clientBuild.metafile.outputs),
]
  .flatMap((output) => output.imports.filter((item) => item.external).map((item) => item.path))
  .filter((name) => !name.startsWith('node:'))
  .map((name) =>
    name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0],
  )
const peers = Object.fromEntries(
  [...new Set([...externalImports, 'zod'])].sort().map((name) => [name, '*']),
)
await writeFile(
  join(output, 'package/package.json'),
  JSON.stringify(
    {
      name: '@one-person-lab/dsh-opl',
      version,
      type: 'module',
      license: 'MIT',
      main: './lib/index.js',
      exports: {
        '.': './lib/index.js',
        './client': './lib/client.js',
        './typert': './lib/typert.host.js',
        './package.json': './package.json',
      },
      peerDependencies: peers,
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: {
          inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings'],
          platform: 'web',
        },
      },
    },
    null,
    2,
  ) + '\n',
)
await cp(join(root, 'installer/skill/harness-mcp.mjs'), join(output, 'package/lib/harness-mcp.mjs'))
await cp(join(root, 'cordis.patch.yml'), join(output, 'package/cordis.patch.yml'))
await mkdir(join(output, 'package/licenses'), { recursive: true })
await cp(
  join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md'),
  join(output, 'package/licenses/claude-agent-sdk.md'),
)
await cp(
  join(root, 'licenses/opl-app-logo-apache-2.0.txt'),
  join(output, 'package/licenses/opl-app-logo-apache-2.0.txt'),
)
for (const file of ['LICENSE', 'NOTICE']) await cp(join(root, file), join(output, 'package', file))
// Windows' bundled bsdtar accepts drive-qualified paths; Git Bash tar treats them as remote archives.
const tar =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
    : 'tar'
const superagent = await buildSuperagent(root, output, tar)
execFileSync(tar, [
  '-czf',
  join(output, `opl-dsh-enhancements-${version}.tgz`),
  '-C',
  output,
  'package',
])
const archive = join(output, `opl-dsh-enhancements-${version}.tgz`)
const digest = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex')
const name = `opl-dsh-enhancements-${version}-${digest.slice(0, 12)}.tgz`
await cp(archive, join(output, name))
await writeFile(join(output, 'artifact.json'), JSON.stringify({ name, sha256: digest }) + '\n')
console.log(join(output, name))

const installer = join(output, 'OPL DSH 一键安装')
await rm(installer, { recursive: true, force: true })
await cp(join(root, 'installer'), installer, { recursive: true })
await cp(join(output, name), join(installer, name))
await cp(join(output, superagent.name), join(installer, superagent.name))
const payloadFiles = {}
for (const file of [
  'official-feed.awk',
  'compare.cjs',
  'install.command',
  'install.cmd',
  'install.ps1',
  'install.mjs',
  'profile.cjs',
  'model-plugins.cjs',
  'kimi-cu.mjs',
  'kimi-cu-windows.mjs',
  'official-pnpm.cjs',
  'migrate.cjs',
  'setup.mjs',
  'superagent.mjs',
  'desktop-platform.mjs',
  'update.mjs',
  'update-discovery.mjs',
  'update-runner.mjs',
  'update-transaction.mjs',
  'desktop-update.mjs',
  'release-manifest.mjs',
  'skill-install.mjs',
  'installation-paths.mjs',
  'skill/SKILL.md',
  'skill/control.mjs',
  'skill/windows-acl.mjs',
  'skill/harness-mcp.mjs',
  'cleanup-skill/SKILL.md',
  'cleanup-skill/cleanup.mjs',
  'cleanup-skill/snapshot.mjs',
  'cleanup-skill/windows-io.mjs',
  'cleanup-skill/agents/openai.yaml',
  'cleanup-skill/references/windows-recycling.md',
  'cleanup-skill/references/provider-contract.md',
  'windows-lifecycle.mjs',
  name,
  superagent.name,
]) {
  payloadFiles[file] = createHash('sha256')
    .update(await readFile(join(installer, file)))
    .digest('hex')
}
const suiteSha256 = createHash('sha256').update(JSON.stringify(payloadFiles)).digest('hex')
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
const sourceDirty =
  execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0
// Published source identity follows Git's tracked set, so new runtime files cannot
// be omitted and local delivery evidence cannot enter the product source hash.
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
const sourceHash = createHash('sha256')
// Homebrew's formula contains the digest of the finished release asset. It is
// derived release metadata and must not create a source-hash/package cycle.
for (const file of [...new Set(sourceFiles)].filter((file) => file !== 'Casks/opl-dsh.rb').sort()) {
  try {
    const bytes = await readFile(join(root, file))
    sourceHash.update(file + '\0')
    sourceHash.update(bytes)
    sourceHash.update('\0')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
const sourceTreeSha256 = sourceHash.digest('hex')
const officialVersion =
  process.env.OPL_OFFICIAL_VERSION ?? project.devDependencies['@deepseek-ai/dsh-agent']
// The public release identity follows the official desktop. The enhancement
// revision remains an internal rollback/update identity.
const artifact = {
  version: officialVersion,
  officialVersion,
  updateProtocolVersion: 1,
  unattendedUpdateProtocolVersion: 1,
  superagent,
  enhancementVersion: version,
  sourceCommit,
  sourceDirty,
  sourceTreeSha256,
  name,
  sha256: digest,
  suiteSha256,
  payloadFiles,
}
await writeFile(join(output, 'artifact.json'), JSON.stringify(artifact, null, 2) + '\n')
await writeFile(join(installer, 'artifact.json'), JSON.stringify(artifact, null, 2) + '\n')
console.log(installer)
