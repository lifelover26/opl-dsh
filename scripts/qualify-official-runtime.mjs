/** Qualify real, unmodified official Desktop with a fresh disposable profile. */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { setTimeout as delay } from 'node:timers/promises'
import {
  assertIsolatedRoot,
  verifyPayload,
  safeBinding,
  sha256,
  installationDiagnostics,
} from './qualification-support.mjs'
import { DesktopPipe, verifyDesktopClient } from './qualification-client.mjs'
import { startModelPluginFixture } from './qualification-model-plugins.mjs'
import {
  verifyHarnessTranscriptClient,
  verifyHarnessLiveTranscriptClient,
} from './qualification-transcript.mjs'

const repo = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(name + ' 缺少参数')
  return args[index + 1]
}
if (args.includes('--help')) {
  console.log(
    'node scripts/qualify-official-runtime.mjs (--app <官方应用目录> | --download) [--payload <构建安装目录>] [--evidence <JSON 文件>] [--keep-profile]',
  )
  process.exit(0)
}
const payload = resolve(option('--payload', join(repo, 'dist/OPL DSH 一键安装')))
const evidenceFile = resolve(
  option('--evidence', join(repo, 'dist/qualification-' + process.platform + '.json')),
)
const suppliedApp = option('--app')
if (Boolean(suppliedApp) === args.includes('--download'))
  throw new Error('必须且只能指定 --app 或 --download')
if (!['darwin', 'win32'].includes(process.platform))
  throw new Error('官方桌面资格验证仅支持 macOS / Windows；本平台未验证')
if (
  args.includes('--download') &&
  process.platform === 'win32' &&
  (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
)
  throw new Error(
    'Windows 官方安装器会注册桌面应用；本机请用 --app，下载模式仅用于临时 GitHub runner',
  )
const artifact = await verifyPayload(payload)
const root = await assertIsolatedRoot(await mkdtemp(join(tmpdir(), 'opl-dsh-accept-')))
const suite = join(root, 'suite')
const runnerSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo,
  encoding: 'utf8',
}).trim()
const runnerSourceDirty =
  execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0
const evidence = {
  schemaVersion: 1,
  status: 'failed',
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  sourceCommit: artifact.sourceCommit,
  sourceTreeSha256: artifact.sourceTreeSha256,
  enhancementVersion: artifact.enhancementVersion,
  enhancementSha256: artifact.sha256,
  suiteSha256: artifact.suiteSha256,
  sourceDirty: artifact.sourceDirty !== false || runnerSourceDirty,
  qualificationRunner: {
    sourceCommit: runnerSourceCommit,
    sourceDirty: runnerSourceDirty,
    ...(runnerSourceDirty
      ? {
          changedTrackedFiles: execFileSync('git', ['diff', '--name-only', 'HEAD'], {
            cwd: repo,
            encoding: 'utf8',
          })
            .trim()
            .split('\n')
            .filter(Boolean),
        }
      : {}),
  },
  protocolProbe: 'local-fixture',
  checks: {},
}
let desktop
let modelPluginFixture
let desktopPipe
let desktopWindow
let interrupted
const children = new Set()
function terminateOwned(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {}
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = signal
    for (const child of [...children, desktop]) terminateOwned(child)
  })
let app = suppliedApp && resolve(suppliedApp)
const environment = {
  ...process.env,
  DSH_HOME: root,
  OPL_DSH_HOME: root,
  OPL_SUITE_ROOT: suite,
  OPL_CODEX_HOME: join(root, 'codex'),
  MINIMAX_DATA_DIR: join(root, 'minimax-fixture-data'),
  OPL_APPLICATIONS_DIR: join(root, 'applications'),
  OPL_INSTALL_NO_LAUNCH: '1',
  OPL_QUALIFICATION_SKIP_PROVIDER_SECRET_WRITE: '1',
  OPL_QUALIFICATION_SKIP_PROVIDER_KEYRING: '1',
  OPL_LEGACY_HOME: join(root, 'empty-legacy'),
  OPL_DESKTOP_LAUNCHER: join(root, 'qualification-launcher'),
  NODE_USE_SYSTEM_CA: '1',
}
process.env.OPL_QUALIFICATION_SKIP_PROVIDER_SECRET_WRITE = '1'
process.env.OPL_QUALIFICATION_SKIP_PROVIDER_KEYRING = '1'
delete environment.OPL_OFFICIAL_ARCHIVE
// The hosted Windows runner enters this script from PowerShell 7. Its PSModulePath
// points at Core-only modules, and an inherited value makes the Windows PowerShell
// 5.1 child resolve Microsoft.PowerShell.Security from there and fail to load the
// cmdlet. Drop the inherited variable in any casing so 5.1 derives its own path.
for (const key of Object.keys(environment))
  if (key.toLowerCase() === 'psmodulepath') delete environment[key]
// An inherited proxy credential or provider key is not needed by fixture qualification.
for (const key of Object.keys(environment))
  if (/API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD/i.test(key))
    delete environment[key]
function run(command, argv, options = {}) {
  return new Promise((accept, reject) => {
    if (interrupted) {
      reject(new Error('资格验证已中断：' + interrupted))
      return
    }
    const child = spawn(command, argv, {
      cwd: repo,
      env: environment,
      windowsHide: true,
      detached: process.platform !== 'win32',
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      error = (error + chunk).slice(-16384)
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      if (!child.pid) return
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          })
        } catch {}
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (failure) {
          if (failure.code !== 'ESRCH') child.kill('SIGKILL')
        }
      }
    }, options.timeout ?? 300000)
    child.once('error', (failure) => {
      children.delete(child)
      clearTimeout(timeout)
      reject(failure)
    })
    child.once('close', (code) => {
      children.delete(child)
      clearTimeout(timeout)
      code === 0 && !timedOut
        ? accept(output)
        : reject(
            new Error(
              '步骤失败：' +
                command +
                ' (exit ' +
                code +
                (timedOut ? ', timeout' : '') +
                ')\n' +
                error.slice(-4096),
            ),
          )
    })
  })
}
async function verifyOfficial() {
  if (process.platform === 'darwin') {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    await run('/usr/bin/codesign', [
      '-v',
      '-R=anchor apple generic and certificate leaf[subject.OU] = "NAN929V4UM" and identifier "com.deepseek.dsh"',
      app,
    ])
    evidence.officialVersion = (
      await run('/usr/libexec/PlistBuddy', [
        '-c',
        'Print CFBundleShortVersionString',
        join(app, 'Contents/Info.plist'),
      ])
    ).trim()
    evidence.officialIdentity = {
      bundleId: 'com.deepseek.dsh',
      teamId: 'NAN929V4UM',
      signatureVerified: true,
    }
  } else {
    const script = `$e=Join-Path $env:OPL_QUALIFY_APP 'DeepSeek Harness.exe'; $verified=$false; $s=Get-AuthenticodeSignature -LiteralPath $e -ErrorAction SilentlyContinue; if($s.Status -eq 'Valid'){$verified=$true}; if(-not $verified){$cu=Get-Command certutil.exe -ErrorAction SilentlyContinue; if($cu){& $cu.Source -verify $e *> $null; $verified=$LASTEXITCODE -eq 0}}; if(-not $verified){throw 'DeepSeek official signature failed'}; (Get-Item -LiteralPath $e).VersionInfo.FileVersion`
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    )
    evidence.officialVersion = (
      await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...environment, OPL_QUALIFY_APP: app },
      })
    ).trim()
    evidence.officialIdentity = {
      publisher: 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.',
      signatureVerified: true,
    }
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(evidence.officialVersion))
    throw new Error('官方应用版本无效')
  const archive = join(
    app,
    process.platform === 'darwin' ? 'Contents/Resources' : 'resources',
    'app.asar',
  )
  evidence.officialAppSha256 = sha256(await readFile(archive))
}
function executable() {
  return join(
    app,
    process.platform === 'darwin' ? 'Contents/MacOS/DeepSeek Harness' : 'DeepSeek Harness.exe',
  )
}
async function startDesktop(profileHome = root, instanceRoot = root) {
  await rm(join(profileHome, 'profiles/desktop/control.json'), { force: true })
  const env = { ...environment, DSH_HOME: profileHome }
  delete env.ELECTRON_RUN_AS_NODE
  desktop = spawn(
    executable(),
    [
      '--user-data-dir=' + join(instanceRoot, 'electron'),
      '--remote-debugging-pipe',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
    {
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      // Live UI qualification needs a visible owned window and an active frame clock.
      windowsHide: false,
    },
  )
  desktopPipe = new DesktopPipe(desktop)
  let spawnError
  let ready = false
  desktop.once('error', (error) => {
    spawnError = error
  })
  for (let attempt = 0; attempt < 180; attempt++) {
    if (interrupted) throw new Error('资格验证已中断：' + interrupted)
    if (spawnError) throw spawnError
    if (desktop.exitCode !== null) throw new Error('隔离桌面提前退出：' + desktop.exitCode)
    try {
      const binding = safeBinding(
        JSON.parse(await readFile(join(profileHome, 'profiles/desktop/control.json'), 'utf8')),
      )
      const result = await fetch(binding.endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
        body: JSON.stringify({ namespace: 'oplSuite', method: 'setupUrl', args: {} }),
        signal: AbortSignal.timeout(2000),
      })
      if ((await result.json()).ok) {
        ready = true
        break
      }
    } catch {}
    await delay(500)
  }
  if (!ready) throw new Error('隔离桌面未在 90 秒内就绪')
  // Reported outside the readiness probe so a hidden content window keeps its
  // own diagnosis instead of collapsing into the readiness timeout.
  desktopWindow = await openVisibleContentWindow()
}
/**
 * A fresh official profile opens the product's own first-run welcome window and
 * keeps the real content window hidden until that gate is resolved. A hidden
 * content window keeps reporting `document.visibilityState === 'hidden'` and its
 * native `requestAnimationFrame` never produces a frame, so every visible-UI
 * assertion downstream would measure a window that is on screen nowhere.
 * The gate is resolved through the official UI itself, entering no credential.
 */
async function resolveWelcomeGate() {
  let welcome
  let welcomeTarget
  for (let attempt = 0; attempt < 60 && !welcome; attempt++) {
    try {
      const { targetInfos } = await desktopPipe.command('Target.getTargets')
      for (const target of targetInfos.filter((entry) => entry.type === 'page')) {
        if (!/welcome\.html?(\?|$)/i.test(target.url)) continue
        // The window is created while the app is still initialising, so a
        // target can disappear between listing and attaching. That is a retry,
        // never a qualification failure.
        const attached = await desktopPipe
          .command('Target.attachToTarget', { targetId: target.targetId, flatten: true })
          .catch(() => null)
        if (!attached) continue
        const matched = await desktopPipe
          .evaluate(
            attached.sessionId,
            'Boolean(document.body && document.body.innerText.includes("DeepSeek Harness"))',
          )
          .catch(() => false)
        if (matched) {
          welcome = attached.sessionId
          welcomeTarget = target.targetId
          break
        }
        await desktopPipe
          .command('Target.detachFromTarget', { sessionId: attached.sessionId })
          .catch(() => {})
      }
    } catch {}
    if (!welcome) await delay(500)
  }
  if (!welcome) return 'absent'
  // The official welcome window offers its own deferred path: open the API key
  // step and take "configure later". No key is typed and none is read back.
  const open = await desktopPipe.evaluate(
    welcome,
    `(() => {const labels=['添加 API Key','Add API Key'];const node=Array.from(document.querySelectorAll('button')).find(x=>x.getClientRects().length&&labels.includes((x.textContent||'').trim()));if(!node)return false;node.click();return true})()`,
  )
  if (!open) throw new Error('官方欢迎窗口缺少 API Key 入口')
  let deferred = false
  for (let attempt = 0; attempt < 20 && !deferred; attempt++) {
    deferred = await desktopPipe
      .evaluate(
        welcome,
        `(() => {const labels=['稍后配置','Set up later','Configure later','Skip for now'];const node=Array.from(document.querySelectorAll('button')).find(x=>x.getClientRects().length&&labels.includes((x.textContent||'').trim()));if(!node)return false;node.click();return true})()`,
      )
      .catch(() => false)
    if (!deferred) {
      // Closing the native window can destroy its execution context before
      // Runtime.evaluate returns the click result. Confirm that exact target
      // disappeared; the caller still requires a visible, painting content page.
      const { targetInfos } = await desktopPipe.command('Target.getTargets')
      deferred = !targetInfos.some((target) => target.targetId === welcomeTarget)
    }
    if (!deferred) await delay(500)
  }
  if (!deferred) {
    const labels = await desktopPipe.evaluate(
      welcome,
      "Array.from(document.querySelectorAll('button')).filter(x=>x.getClientRects().length).map(x=>(x.textContent||'').trim())",
    )
    throw new Error('官方欢迎窗口无法在无凭据条件下继续；入口：' + JSON.stringify(labels))
  }
  await desktopPipe.command('Target.detachFromTarget', { sessionId: welcome }).catch(() => {})
  return 'dismissed'
}
/** Attach the real content page and prove it is actually visible and painting. */
async function openVisibleContentWindow() {
  const welcomeGate = await resolveWelcomeGate()
  let session
  for (let attempt = 0; attempt < 120 && !session; attempt++) {
    try {
      const { targetInfos } = await desktopPipe.command('Target.getTargets')
      for (const target of targetInfos.filter((entry) => entry.type === 'page')) {
        const attached = await desktopPipe
          .command('Target.attachToTarget', { targetId: target.targetId, flatten: true })
          .catch(() => null)
        if (!attached) continue
        const matched = await desktopPipe
          .evaluate(attached.sessionId, 'Boolean(document.body && globalThis.__ModuleLoader__)')
          .catch(() => false)
        if (matched) {
          session = attached.sessionId
          break
        }
        await desktopPipe
          .command('Target.detachFromTarget', { sessionId: attached.sessionId })
          .catch(() => {})
      }
    } catch {}
    if (!session) await delay(500)
  }
  if (!session) throw new Error('未发现官方桌面 Client 页面')
  let visible = false
  for (let attempt = 0; attempt < 60 && !visible; attempt++) {
    visible = await desktopPipe
      .evaluate(session, `document.visibilityState === 'visible'`)
      .catch(() => false)
    if (!visible) await delay(500)
  }
  if (!visible) {
    const state = await desktopPipe
      .evaluate(session, '({visibility:document.visibilityState,focus:document.hasFocus()})')
      .catch((error) => ({ evaluateError: String(error.message) }))
    throw new Error('官方桌面内容窗口未进入可见状态：' + JSON.stringify(state))
  }
  // The live assertions need a real native frame, not just a reported state.
  const frame = desktopPipe
    .evaluate(session, `new Promise(resolve => requestAnimationFrame(() => resolve('fired')))`)
    .catch(() => 'no-frame')
  const nativeFrameClock =
    (await Promise.race([frame, delay(10000).then(() => 'no-frame')])) === 'fired'
  if (!nativeFrameClock) throw new Error('官方桌面内容窗口未产生原生动画帧')
  return { welcomeGate, mainWindowVisible: true, nativeFrameClock: true }
}
async function stopDesktop() {
  if (!desktop) return
  if (desktop.exitCode !== null || desktop.signalCode !== null) {
    desktop = undefined
    return
  }
  const owned = desktop
  try {
    await desktopPipe.command('Browser.close')
  } catch {
    // Closing the browser disconnects the CDP pipe before it can return a response.
  }
  for (
    let attempt = 0;
    owned.exitCode === null && owned.signalCode === null && attempt < 40;
    attempt++
  )
    await delay(100)
  if (owned.exitCode === null && owned.signalCode === null) {
    if (process.platform === 'win32') owned.kill()
    else {
      // Only the process group created by this runner is eligible for cleanup.
      try {
        process.kill(-owned.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    for (
      let attempt = 0;
      owned.exitCode === null && owned.signalCode === null && attempt < 40;
      attempt++
    )
      await delay(100)
    if (owned.exitCode === null && owned.signalCode === null)
      throw new Error('隔离 Desktop 未能在受控退出后停止')
  }
  desktop = undefined
}
try {
  // Only the fixture CLI is used below. Keep its login-presence hint isolated
  // from the operator's account; no real credential contents are needed.
  const minimaxAuth = join(environment.MINIMAX_DATA_DIR, 'auth', 'en', 'mcode-public')
  await mkdir(minimaxAuth, { recursive: true })
  await writeFile(join(minimaxAuth, 'auth.json'), '', { mode: 0o600 })
  // An existing empty migration source takes precedence over every user legacy path.
  await mkdir(environment.OPL_LEGACY_HOME, { recursive: true })
  await writeFile(environment.OPL_DESKTOP_LAUNCHER, 'Qualification owns launch and cleanup.\n', {
    mode: 0o600,
  })
  if (args.includes('--download')) {
    if (process.platform === 'darwin') {
      await run('/bin/bash', [join(payload, 'install.command')], { timeout: 1200000 })
      app = join(environment.OPL_APPLICATIONS_DIR, 'DeepSeek Harness.app')
    } else {
      await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(payload, 'install.ps1'),
          '-Root',
          suite,
          '-Payload',
          payload,
          '-NoLaunch',
        ],
        { timeout: 1200000 },
      )
      app = JSON.parse(await readFile(join(suite, 'installation.json'), 'utf8')).app
    }
    evidence.checks.downloadIntegrity = { sha512: true, owner: 'official installer' }
  }
  await verifyOfficial()
  environment.OPL_QUALIFICATION_OFFICIAL_VERSION = evidence.officialVersion
  const profile = join(root, 'profiles/desktop')
  await mkdir(profile, { recursive: true })
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    // A fresh test profile must not import the operator's legacy keyring.
    '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n',
    { mode: 0o600 },
  )
  if (suppliedApp)
    await run(executable(), [join(payload, 'install.mjs'), app, suite, payload, '--no-launch'], {
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
    })
  evidence.checks.isolatedInstallation = true
  const sourcePackage = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
  evidence.checks.dependencyIsolation = JSON.parse(
    await run(
      executable(),
      [
        join(repo, 'scripts/qualification-dependencies.mjs'),
        app,
        profile,
        sourcePackage.devDependencies.zod,
      ],
      { env: { ...environment, ELECTRON_RUN_AS_NODE: '1' } },
    ),
  )
  modelPluginFixture = await startModelPluginFixture()
  Object.assign(environment, modelPluginFixture.environment)
  const historyProject = join(root, 'test-project')
  await mkdir(historyProject, { recursive: true })
  await writeFile(
    join(profile, 'harness-sessions.json'),
    JSON.stringify([
      {
        id: 'harness-qualification-history',
        combination: 'grok-build/grok-4.7',
        harnessRef: 'grok-build',
        modelRef: { provider: 'opl-gateway', model: 'grok::grok-4.7' },
        cwd: historyProject,
        origin: { kind: 'desktop', sessionId: 'isolated-acceptance' },
        acpSessionId: 'test-native',
        title: '历史外部任务 中文',
        sandbox: process.platform === 'win32' ? 'full-access' : 'read-only',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        turns: [
          {
            operationId: 'history',
            fingerprint: 'qualification-history',
            prompt: '历史用户消息 HISTORY_USER',
            text: '历史模型回答 HISTORY_RESULT',
            state: 'completed',
            tools: [],
          },
        ],
      },
    ]) + '\n',
  )
  await startDesktop()
  evidence.checks.desktopWindow = desktopWindow
  await mkdir(resolve(evidenceFile, '..'), { recursive: true })
  // Establish real fixture model routes and saved combinations through their owners
  // before the UI checks toggle them. A clean profile has no usable account model.
  evidence.checks.runtime = JSON.parse(
    await run(process.execPath, [join(repo, 'scripts/verify-official-runtime.mjs'), root], {
      // Windows discovery runs real CLI and credential helpers. Keep a finite
      // overall bound without preempting their per-request completion budgets.
      timeout: process.platform === 'win32' ? 900000 : 300000,
    }),
  )
  evidence.checks.client = await verifyDesktopClient(
    desktopPipe,
    evidenceFile.replace(/\.json$/, '') + '-client',
    (progress) => {
      evidence.checks.client = progress
    },
    async (expected, ref = 'BAMBOO_STARTLUX_API_KEY') => {
      const stored = parseYaml(await readFile(join(root, '.credentials.yaml'), 'utf8'))
      if (stored.refs?.[ref] !== expected) throw new Error('原生表单与隔离测试凭据存储回读不一致')
    },
    evidence.officialVersion,
    JSON.parse(await readFile(join(root, 'qualification-conversation-counts.json'), 'utf8')),
    async () => {
      const binding = safeBinding(
        JSON.parse(await readFile(join(root, 'profiles/desktop/control.json'), 'utf8')),
      )
      const response = await fetch(binding.endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
        body: JSON.stringify({ namespace: 'harness', method: 'catalog', args: {} }),
        signal: AbortSignal.timeout(30000),
      })
      const result = await response.json()
      if (!result.ok) throw new Error('隔离执行组合目录回读失败')
      return result.value
    },
  )
  if (!modelPluginFixture.requests.some((request) => request.usedTool))
    throw new Error('原版模型插件未完成官方工具调用后的模型回复')
  const mcpAppHost = modelPluginFixture.requests.find(
    (request) => request.hostDiagnostic,
  )?.hostDiagnostic
  if (!mcpAppHost) throw new Error('原版桌面未回读 MCP Apps 宿主诊断结果')
  evidence.checks.mcpAppHost = mcpAppHost
  evidence.checks.modelPluginRequests = modelPluginFixture.requests
  if (evidence.checks.runtime.harnessTranscript)
    evidence.checks.transcriptClient = await verifyHarnessTranscriptClient(
      desktopPipe,
      evidenceFile.replace(/\.json$/, '') + '-transcript.png',
    )
  if (args.includes('--live-transcript'))
    evidence.checks.liveTranscriptClient = await verifyHarnessLiveTranscriptClient(
      desktopPipe,
      root,
      evidenceFile.replace(/\.json$/, '') + '-live-transcript.png',
    )
  evidence.checks.selectionBaseline = JSON.parse(
    await run(process.execPath, [
      join(repo, 'scripts/verify-official-runtime.mjs'),
      root,
      '--capture-selections',
    ]),
  )
  await stopDesktop()
  await startDesktop()
  evidence.checks.restartWindow = desktopWindow
  evidence.checks.restart = JSON.parse(
    await run(process.execPath, [
      join(repo, 'scripts/verify-official-runtime.mjs'),
      root,
      '--readback-selections',
    ]),
  )
  await stopDesktop()
  if (process.platform === 'darwin' && artifact.superagent) {
    const { verifySuperagent } = await import('./qualification-superagent.mjs')
    const { openSuperagent } = await import(join(payload, 'superagent.mjs'))
    const installed = JSON.parse(await readFile(join(suite, 'installation.json'), 'utf8'))
    const opened = await openSuperagent(installed, {
      start: async ({ home, root: instanceRoot }) => {
        await startDesktop(home, instanceRoot)
        return { pid: desktop.pid }
      },
    })
    if (opened.state !== 'opened') throw new Error('SuperAgent 未完成独立启动')
    evidence.checks.superagent = await verifySuperagent(
      desktopPipe,
      evidenceFile.replace(/\.json$/, '-client-superagent.png'),
    )
    await stopDesktop()
  }
  const originalHash = evidence.officialAppSha256
  await verifyOfficial()
  if (evidence.officialAppSha256 !== originalHash) throw new Error('官方应用内容在验收期间发生变化')
  evidence.checks.officialUnmodified = true
  evidence.status = 'passed'
} catch (error) {
  // Keep output free of control bearer tokens and provider credentials.
  evidence.failure = String(error.message).replace(/Bearer\s+[^\s"']+/g, 'Bearer [REDACTED]')
  evidence.installationDiagnostics = await installationDiagnostics(root).catch((failure) => [
    String(failure.message),
  ])
  process.exitCode = 1
} finally {
  if (modelPluginFixture) await modelPluginFixture.close()
  try {
    await stopDesktop()
  } catch (error) {
    evidence.cleanupFailure = String(error.message)
    evidence.status = 'failed'
    process.exitCode = 1
  }
  evidence.finishedAt = new Date().toISOString()
  if (args.includes('--keep-profile')) evidence.isolatedProfile = root
  else if (!desktop) {
    // Windows can hold a handle on the disposable Electron profile (leveldb) briefly
    // after the process exits. Scratch cleanup must never discard the evidence file,
    // so retry and record a residual failure instead of throwing out of `finally`.
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 4) {
          evidence.scratchCleanupFailure = String(error.message)
          break
        }
        await delay(500)
      }
    }
  }
  await mkdir(resolve(evidenceFile, '..'), { recursive: true })
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(
    JSON.stringify({
      status: evidence.status,
      evidence: evidenceFile,
      officialVersion: evidence.officialVersion,
    }),
  )
}
