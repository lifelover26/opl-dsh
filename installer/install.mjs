import { installCleanupSkill, installSkill, verifySkill } from './skill-install.mjs'
import { isLocalCandidateInstall } from './update.mjs'
import { installKimiCu } from './kimi-cu.mjs'
import { installWindowsKimiCu } from './kimi-cu-windows.mjs'
/** Install OPL-owned files into the official DSH profile, then launch the official app. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, cpSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { launchIndependent, windowsSuiteLauncher } from './windows-lifecycle.mjs'
const [app, root, payload, ...flags] = process.argv.slice(2)
// The official desktop resolves the same default when DSH_HOME is unset.
const home = process.env.OPL_DSH_HOME?.trim() || join(homedir(), '.dsh')
const executable =
  process.platform === 'win32'
    ? join(app, 'DeepSeek Harness.exe')
    : join(app, 'Contents/MacOS/DeepSeek Harness')
const bindingPath = join(home, 'profiles/desktop/control.json')
const previousInstallation = existsSync(join(root, 'installation.json'))
  ? JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8'))
  : undefined
const codexHome =
  process.env.OPL_CODEX_HOME ??
  process.env.CODEX_HOME ??
  (previousInstallation?.skillDir
    ? dirname(dirname(previousInstallation.skillDir))
    : join(homedir(), '.codex'))
// Refuse a modified or foreign Skill before changing the official profile.
verifySkill(join(codexHome, 'skills/opl-dsh-official'))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('安装步骤失败，未启动应用')
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
function desktopProcessesAlive() {
  const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return result.status === 0 && result.stdout.includes('DeepSeek Harness.exe')
}
async function idleTasks(binding) {
  const response = await fetch(binding.endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      namespace: 'taskFeedback',
      method: 'tasks',
      args: {},
      timeoutMs: 150000,
    }),
    signal: AbortSignal.timeout(155000),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error || '无法读取 DSH 任务状态')
  const tasks = result.value
  if (!Array.isArray(tasks)) throw new Error('DSH 任务状态不是有效列表')
  const active = tasks.filter((task) =>
    [
      'queued',
      'running',
      'waiting_approval',
      'waiting_input',
      'waiting_child',
      'interrupted',
    ].includes(task.state),
  )
  if (active.length) throw new Error(`仍有 ${active.length} 个 DSH 任务活动，已停止安装`)
}
async function closeDesktop(pid) {
  if (process.platform !== 'win32') return
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T'], { windowsHide: true })
  spawnSync('taskkill.exe', ['/IM', 'DeepSeek Harness.exe', '/T'], { windowsHide: true })
  for (let i = 0; i < 40 && (alive(pid) || desktopProcessesAlive()); i++)
    await new Promise((resolve) => setTimeout(resolve, 250))
  if (alive(pid) || desktopProcessesAlive())
    spawnSync('taskkill.exe', ['/IM', 'DeepSeek Harness.exe', '/T', '/F'], { windowsHide: true })
  for (let i = 0; i < 40 && (alive(pid) || desktopProcessesAlive()); i++)
    await new Promise((resolve) => setTimeout(resolve, 250))
  if (alive(pid) || desktopProcessesAlive()) throw new Error('DSH 无法退出，已停止安装')
}
if (existsSync(bindingPath)) {
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8'))
  if (alive(binding.pid)) {
    if (flags.includes('--update-if-stopped'))
      throw new Error('Desktop 仍在运行，已保留待更新包；退出后重新启动再更新')
    await idleTasks(binding)
    await closeDesktop(binding.pid)
  }
}
const artifact = JSON.parse(readFileSync(join(payload, 'artifact.json'), 'utf8'))
if (!/^opl-dsh-enhancements-[a-zA-Z0-9.-]+\.tgz$/.test(artifact.name))
  throw new Error('安装清单无效')
const bytes = readFileSync(join(payload, artifact.name))
if (digest(bytes) !== artifact.sha256) throw new Error('增强包校验失败')
if (
  !artifact.payloadFiles ||
  digest(JSON.stringify(artifact.payloadFiles)) !== artifact.suiteSha256
)
  throw new Error('套件安装清单无效')
for (const [file, expected] of Object.entries(artifact.payloadFiles)) {
  if (
    file.startsWith('/') ||
    file.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw new Error('套件路径无效')
  if (digest(readFileSync(join(payload, file))) !== expected)
    throw new Error('套件文件校验失败：' + file)
}
const release = join(root, 'releases', artifact.suiteSha256)
if (existsSync(release)) {
  for (const [file, expected] of Object.entries(artifact.payloadFiles))
    if (digest(readFileSync(join(release, file))) !== expected)
      throw new Error('已有安装文件被修改，已保留：' + file)
} else {
  mkdirSync(release, { recursive: true, mode: 0o700 })
  cpSync(payload, release, { recursive: true })
}
// Import legacy data before creating the new official profile. The old source is preserved.
run(executable, [join(release, 'migrate.cjs'), app, home, root], { ELECTRON_RUN_AS_NODE: '1' })
const patch = join(home, 'profiles/desktop/cordis.patch.yml')
mkdirSync(dirname(patch), { recursive: true, mode: 0o700 })
if (!existsSync(patch))
  writeFileSync(
    patch,
    '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n    compression: gzip\n    compressionLevel: 1\n    compressionThresholdBytes: 1024\n',
    { mode: 0o600, flag: 'wx' },
  )
run(executable, [join(release, 'profile.cjs'), app, home, join(release, artifact.name)], {
  ELECTRON_RUN_AS_NODE: '1',
})
const compatibilityLauncher = join(
  root,
  process.platform === 'win32' ? 'launch.vbs' : 'launch.command',
)
// A compatibility launcher remains available to the Skill. It is not the user-facing entry point.
const launcher = process.env.OPL_DESKTOP_LAUNCHER ?? compatibilityLauncher
if (!process.env.OPL_DESKTOP_LAUNCHER) {
  if (process.platform === 'win32') {
    writeFileSync(
      compatibilityLauncher,
      Buffer.from(
        '\ufeff' +
          windowsSuiteLauncher({
            executable,
            setup: join(release, 'setup.mjs'),
            home,
            root,
            app,
            codexHome,
          }),
        'utf16le',
      ),
    )
    const script = `
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @('Programs', 'Desktop')) {
  $directory = [Environment]::GetFolderPath($folder)
  if (-not $directory) { throw "Cannot locate $folder for the OPL DSH shortcut" }
  $shortcut = $shell.CreateShortcut((Join-Path $directory 'DeepSeek Harness.lnk'))
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\\wscript.exe'
  $shortcut.Arguments = [char]34 + $env:OPL_SHORTCUT_SCRIPT + [char]34
  $shortcut.WorkingDirectory = Split-Path -Parent $env:OPL_SHORTCUT_SCRIPT
  $shortcut.IconLocation = $env:OPL_SHORTCUT_ICON
  $shortcut.Save()
}
`
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      OPL_SHORTCUT_SCRIPT: compatibilityLauncher,
      OPL_SHORTCUT_ICON: executable,
    })
  } else {
    writeFileSync(
      compatibilityLauncher,
      '#!/bin/bash\nset -euo pipefail\nexport NODE_USE_SYSTEM_CA=1\nexport ELECTRON_RUN_AS_NODE=1\nexec ' +
        quote(executable) +
        ' ' +
        quote(join(release, 'setup.mjs')) +
        ' ' +
        quote(home) +
        ' ' +
        quote(root) +
        ' ' +
        quote(app) +
        '\n',
      { mode: 0o700 },
    )
  }
}
const skillDir = installSkill({ executable, home, launcher, root, release, codexHome })
const cleanupSkillDir = installCleanupSkill({ release, codexHome })
const computerUse = await (process.platform === 'win32' ? installWindowsKimiCu : installKimiCu)({
  suiteRoot: root,
  log: (message) => process.stdout.write(`${message}\n`),
})
const resources = join(app, process.platform === 'win32' ? 'resources' : 'Contents/Resources')
const manifestPath = join(resources, 'app.asar/package.json')
const manifest = spawnSync(
  executable,
  ['-e', `process.stdout.write(require(${JSON.stringify(manifestPath)}).version)`],
  { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
)
if (manifest.error || manifest.status !== 0 || !manifest.stdout.trim())
  throw manifest.error ?? new Error('无法读取官方桌面版本')
const officialVersion = manifest.stdout.trim()
const ledgerDir = JSON.parse(readFileSync(join(skillDir, 'config.json'), 'utf8')).ledger
const installation = {
  version: 3,
  suiteRoot: root,
  profileHome: home,
  ledgerDir,
  previousRelease:
    previousInstallation?.release !== release
      ? previousInstallation?.release
      : previousInstallation?.previousRelease,
  suiteVersion: artifact.enhancementVersion ?? artifact.version,
  localCandidate: isLocalCandidateInstall(artifact, flags),
  officialVersion,
  app,
  home,
  release,
  enhancementSha256: artifact.sha256,
  suiteSha256: artifact.suiteSha256,
  launcher,
  compatibilityLauncher,
  skillDir,
  cleanupSkillDir,
  computerUse,
  installedAt: new Date().toISOString(),
}
mkdirSync(join(home, 'opl-dsh'), { recursive: true, mode: 0o700 })
writeFileSync(join(root, 'installation.json'), JSON.stringify(installation, null, 2) + '\n', {
  mode: 0o600,
})
writeFileSync(
  join(home, 'opl-dsh', 'installation.json'),
  JSON.stringify(installation, null, 2) + '\n',
  { mode: 0o600 },
)
console.log('官方桌面和 OPL 增强已安装。Codex Skill：opl-dsh-official。')
if (process.platform === 'darwin' && computerUse.state === 'installed')
  console.log('KimiCU Computer Use 已安装；首次使用请在系统设置中授予辅助功能和屏幕录制权限。')
else if (process.platform === 'darwin' && computerUse.state === 'deferred')
  console.log('KimiCU Computer Use 未完成安装；DSH 其他功能可继续使用，详情见安装回执。')
if (!flags.includes('--no-launch')) {
  // Same entry point as the desktop shortcut and the Skill: launch.vbs sets
  // ELECTRON_RUN_AS_NODE and setup.mjs receives home/root/app as argv, so the
  // start carries no state that a Job-independent broker could lose.
  const started = launchIndependent({
    command: process.platform === 'win32' ? 'wscript.exe' : compatibilityLauncher,
    args: process.platform === 'win32' ? [compatibilityLauncher] : [],
    label: 'install-auto-launch',
  })
  if (started.refusal) {
    console.error(started.refusal)
    process.exitCode = 1
  }
}
