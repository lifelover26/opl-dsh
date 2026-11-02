/** Package an unchanged official MCode npm release with the source-owned ACP overlay. */
import {
  cpSync,
  copyFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { distribution, verifyOfficialDistribution } from './distribution.mjs'
import {
  assertNotProtected,
  assertSafeArchiveEntries,
  run,
  sha256File,
  writeJson,
} from './shared.mjs'
import { candidateFiles, launcherContent, scanForCredentials } from './pipeline.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    archive: { type: 'string' },
    node: { type: 'string' },
    license: { type: 'string' },
    proxy: { type: 'string' },
  },
})
for (const key of ['out', 'archive', 'node', 'license'])
  if (!values[key]) throw Error(`Missing --${key}.`)
const base = assertNotProtected(resolve(values.out))
if (existsSync(base)) throw Error('Output must be a new exclusive directory.')
const archive = resolve(values.archive)
const bytes = readFileSync(archive)
if (
  bytes.length !== distribution.official.archiveBytes ||
  createHash('sha512').update(bytes).digest('base64') !== distribution.official.archiveSha512
)
  throw Error('Official npm archive integrity mismatch.')
if (sha256File(resolve(values.license)) !== distribution.license.sha256)
  throw Error('Official license integrity mismatch.')
const node = resolve(values.node)
const nodeVersion = run([node, '-p', 'process.versions.node']).trim()
if (!/^(?:24|25|26)\./.test(nodeVersion))
  throw Error('Use a supported Node 24–26 runtime for this portable candidate.')
const tar =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe')
    : 'tar'
const list = run([tar, '-tf', archive]).split(/\r?\n/).filter(Boolean)
assertSafeArchiveEntries(list)
if (list.some((name) => !name.startsWith('package/'))) throw Error('Unexpected npm archive root.')
mkdirSync(join(base, 'official'), { recursive: true })
run([tar, '-xf', archive, '--strip-components=1', '-C', join(base, 'official')])
verifyOfficialDistribution(join(base, 'official'))
const npm = join(node, '..', 'npm.cmd')
if (!existsSync(npm)) throw Error('npm.cmd must accompany the build Node runtime.')
const env = { ...process.env, PATH: join(node, '..') + ';' + process.env.PATH }
const args = [
  npm,
  'install',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--cache',
  join(base, '..', 'npm-cache'),
  '--registry=https://registry.npmjs.org',
]
if (values.proxy) args.push('--proxy=' + values.proxy, '--https-proxy=' + values.proxy)
run(args, { cwd: join(base, 'official'), env })
verifyOfficialDistribution(join(base, 'official'))
const overlay = new URL('./overlay/', import.meta.url)
cpSync(overlay, join(base, 'overlay'), { recursive: true })
copyFileSync(resolve(values.license), join(base, 'LICENSE'))
copyFileSync(node, join(base, 'node.exe'))
writeFileSync(join(base, 'cli.js'), "import './overlay/cli.mjs'\n")
writeJson(join(base, 'package.json'), {
  name: distribution.official.packageName,
  version: distribution.candidateVersion,
  type: 'module',
})
writeFileSync(join(base, 'mcode.cmd'), launcherContent('node.exe'))
writeFileSync(
  join(base, 'CANDIDATE.md'),
  `# MCode ${distribution.official.version} + OPL ACP overlay\n\n官方 npm 文件逐字节保留。Git Bash 使用官方按会话绑定；OPL 提供 conversation-only 历史扩展及受控登录取消。账号仍由官方 CLI 管理。不是官方发布物，不自动更新。\n`,
)
scanForCredentials(base)
// npm's own dependency lock is part of the portable artifact, not an account file.
const files = candidateFiles(base).map((file) => ({
  file,
  bytes: readFileSync(join(base, file)).length,
  sha256: sha256File(join(base, file)),
}))
writeJson(join(base, 'manifest.json'), {
  schemaVersion: 1,
  version: distribution.candidateVersion,
  distribution: 'official-npm-overlay',
  officialNpm: distribution.official,
  officialInstallModified: false,
  accountCopied: false,
  toolchainStubbed: false,
  nodeRuntime: { path: 'node.exe', version: nodeVersion, sha256: sha256File(node) },
  externalModules: { copied: distribution.externalModules },
  files,
})
console.log(
  JSON.stringify({
    candidate: base,
    version: distribution.candidateVersion,
    files: files.length,
    officialFilesUnchanged: true,
  }),
)
