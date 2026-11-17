/** Install the OPL enhancement suite into an isolated Linux CLI/Web profile. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { installSkill, verifySkill } from './skill-install.mjs'

if (process.platform !== 'linux') throw new Error('此安装入口仅支持 Linux')

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const payload = resolve(
  process.argv[2] ??
    (import.meta.dirname.endsWith('/installer')
      ? join(import.meta.dirname, '..', 'dist', 'OPL DSH 一键安装')
      : import.meta.dirname),
)
const home = resolve(
  process.env.OPL_DSH_HOME?.trim() || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'),
)
const root = resolve(
  process.env.OPL_SUITE_ROOT?.trim() ||
    join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'OPL DSH Suite'),
)
const profile = process.env.OPL_PROFILE_NAME?.trim() || 'opl-linux'
if (!/^[a-z][a-z0-9-]*$/u.test(profile) || ['desktop', 'web'].includes(profile))
  throw new Error('Linux 安装需要独立的自定义 profile 名称，不能是 desktop 或 web')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`命令执行失败：${command}`)
  return result.stdout?.trim() ?? ''
}

function executablePath(command) {
  if (command.includes('/')) return resolve(command)
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!directory) continue
    const candidate = join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error(`找不到可执行程序：${command}`)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

const artifact = JSON.parse(readFileSync(join(payload, 'artifact.json'), 'utf8'))
if (
  typeof artifact.officialVersion !== 'string' ||
  !/^opl-dsh-enhancements-[a-zA-Z0-9.-]+\.tgz$/u.test(artifact.name) ||
  !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
  !artifact.payloadFiles ||
  digest(JSON.stringify(artifact.payloadFiles)) !== artifact.suiteSha256
)
  throw new Error('Linux 安装清单无效')
if (digest(readFileSync(join(payload, artifact.name))) !== artifact.sha256)
  throw new Error('OPL 增强包校验失败')
for (const [file, expected] of Object.entries(artifact.payloadFiles)) {
  if (
    typeof expected !== 'string' ||
    file.startsWith('/') ||
    file.split('/').some((part) => !part || part === '..' || part === '.') ||
    digest(readFileSync(join(payload, file))) !== expected
  )
    throw new Error(`套件文件校验失败：${file}`)
}
const featurePlugins = artifact.plugins ?? []
if (
  featurePlugins.length !== 2 ||
  featurePlugins.some(
    (plugin, index) =>
      plugin.package !==
        ['@one-person-lab/dsh-execution', '@one-person-lab/dsh-collaboration'][index] ||
      !/^opl-dsh-(execution|collaboration)-[a-zA-Z0-9.-]+\.tgz$/u.test(plugin.name) ||
      artifact.payloadFiles[plugin.name] !== plugin.sha256,
  )
)
  throw new Error('OPL 功能插件清单无效')

const dshCommand = process.env.OPL_DSH_CLI?.trim() || 'dsh'
const dshExecutable = executablePath(dshCommand)
const cliVersion = run(dshExecutable, ['--version'])
if (cliVersion !== artifact.officialVersion)
  throw new Error(`需要 DSH ${artifact.officialVersion}，当前命令为 ${cliVersion}`)
const cliRoot = process.env.OPL_DSH_INSTALL_DIR?.trim()
  ? resolve(process.env.OPL_DSH_INSTALL_DIR)
  : join(run('npm', ['root', '-g']), '@deepseek-ai', 'dsh')
const cliManifest = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'))
if (cliManifest.name !== '@deepseek-ai/dsh' || cliManifest.version !== artifact.officialVersion)
  throw new Error('DSH 安装目录与增强包目标版本不匹配')

const bindingPath = join(home, 'profiles', profile, 'control.json')
if (existsSync(bindingPath)) {
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8'))
  if (alive(binding.pid)) throw new Error(`profile ${profile} 仍在运行，请先正常退出`)
}
const previousInstallation = existsSync(join(root, 'installation.json'))
  ? JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8'))
  : undefined
const codexHome =
  process.env.OPL_CODEX_HOME ??
  process.env.CODEX_HOME ??
  (previousInstallation?.skillDir
    ? dirname(dirname(previousInstallation.skillDir))
    : join(homedir(), '.codex'))
verifySkill(join(codexHome, 'skills/opl-dsh-official'))

mkdirSync(home, { recursive: true, mode: 0o700 })
mkdirSync(root, { recursive: true, mode: 0o700 })
const release = join(root, 'releases', artifact.suiteSha256)
if (resolve(payload) !== release) {
  if (existsSync(release)) {
    for (const [file, expected] of Object.entries(artifact.payloadFiles))
      if (digest(readFileSync(join(release, file))) !== expected)
        throw new Error(`已有安装文件被修改，已保留：${file}`)
  } else {
    mkdirSync(release, { recursive: true, mode: 0o700 })
    cpSync(payload, release, { recursive: true })
  }
}
const env = {
  ...process.env,
  DSH_HOME: home,
  OPL_DSH_CLI_PROFILE: profile,
  OPL_DSH_INSTALL_DIR: cliRoot,
}
delete env.DSH_PROFILE
delete env.DSH_PROFILE_DIR
delete env.ELECTRON_RUN_AS_NODE
run(
  process.execPath,
  [
    join(release, 'profile.cjs'),
    cliRoot,
    home,
    join(release, artifact.name),
    ...featurePlugins.map((plugin) => '--plugin=' + join(release, plugin.name)),
  ],
  { env, stdio: 'inherit' },
)

const launcher = join(root, 'launch-opl-linux.sh')
const launcherText =
  '#!/bin/bash\nset -euo pipefail\n' +
  `export DSH_HOME=${quote(home)}\n` +
  `export DSH_PROFILE=${quote(profile)}\n` +
  `export DSH_PROFILE_DIR=${quote(join(home, 'profiles', profile))}\n` +
  `export OPL_PROFILE_NAME=${quote(profile)}\n` +
  `export OPL_SUITE_ROOT=${quote(root)}\n` +
  `export OPL_OFFICIAL_VERSION=${quote(artifact.officialVersion)}\n` +
  'export NODE_USE_SYSTEM_CA=1\n' +
  `exec ${quote(dshExecutable)} --profile ${quote(profile)} --host 127.0.0.1 --port "\${OPL_LINUX_PORT:-4180}" --no-open "$@"\n`
if (existsSync(launcher) && readFileSync(launcher, 'utf8') !== launcherText)
  throw new Error(`启动器与本次安装不同，已保留：${launcher}`)
writeFileSync(launcher, launcherText, { mode: 0o700 })
const skillDir = installSkill({
  executable: process.execPath,
  home,
  profileHome: home,
  profile,
  launcher,
  root,
  release,
  codexHome,
})
const ledgerDir = JSON.parse(readFileSync(join(skillDir, 'config.json'), 'utf8')).ledger
const installation = {
  version: 3,
  suiteRoot: root,
  profileHome: home,
  profile,
  runtime: 'cli',
  ledgerDir,
  previousRelease:
    previousInstallation?.release !== release
      ? previousInstallation?.release
      : previousInstallation?.previousRelease,
  suiteVersion: artifact.enhancementVersion ?? artifact.version,
  localCandidate: true,
  updateSupported: false,
  officialVersion: artifact.officialVersion,
  app: cliRoot,
  home,
  release,
  enhancementSha256: artifact.sha256,
  suiteSha256: artifact.suiteSha256,
  launcher,
  compatibilityLauncher: launcher,
  skillDir,
  computerUse: { state: 'unsupported', reason: 'linux' },
  cleanupSkill: { state: 'unsupported', reason: 'windows-only' },
  platform: process.platform,
  arch: process.arch,
  installedAt: new Date().toISOString(),
}
mkdirSync(join(home, 'opl-dsh'), { recursive: true, mode: 0o700 })
for (const file of [join(root, 'installation.json'), join(home, 'opl-dsh/installation.json')])
  writeFileSync(file, JSON.stringify(installation, null, 2) + '\n', { mode: 0o600 })
console.log(
  JSON.stringify(
    {
      installed: true,
      profile,
      officialVersion: artifact.officialVersion,
      suiteVersion: installation.suiteVersion,
      suiteRoot: root,
      launcher,
      skillDir,
      unsupported: ['KimiCU', 'session-cleanup', 'automatic-enhancement-updates'],
    },
    null,
    2,
  ),
)
