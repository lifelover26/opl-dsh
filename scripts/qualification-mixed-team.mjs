/** Exercise real external members in an isolated, unmodified official Desktop. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { parse, stringify } from 'yaml'
import { DesktopPipe, verifyPluginPresentation } from './qualification-client.mjs'
import { verifyRoleClient } from './qualification-role-client.mjs'

const repo = resolve(import.meta.dirname, '..')
const rootArg = process.argv.find((arg) => arg.startsWith('--root='))?.slice(7)
const root = rootArg ?? (await mkdtemp(join(tmpdir(), 'opl-mixed-team-')))
const app = process.env.OPL_OFFICIAL_APP ?? join(homedir(), 'Applications/DeepSeek Harness.app')
const executable = join(
  app,
  process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'Contents/MacOS/DeepSeek Harness',
)
const appArchive = join(
  app,
  process.platform === 'win32' ? 'resources/app.asar' : 'Contents/Resources/app.asar',
)
const profile = join(root, 'profiles/desktop')
const workspace = join(root, 'workspace')
const artifact = JSON.parse(await readFile(join(repo, 'dist/artifact.json'), 'utf8'))
const env = {
  ...process.env,
  DSH_HOME: root,
  OPL_DSH_HOME: root,
  OPL_SUITE_ROOT: join(root, 'suite'),
  OPL_LEGACY_HOME: join(root, 'empty-legacy'),
  DSH_TELEMETRY_DISABLED: '1',
  NODE_USE_SYSTEM_CA: '1',
}
for (const name of Object.keys(env))
  if (/(API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN)$/.test(name)) delete env[name]
await mkdir(workspace, { recursive: true })
await mkdir(env.OPL_LEGACY_HOME, { recursive: true })
await mkdir(profile, { recursive: true })
const hash = async () =>
  createHash('sha256')
    .update(await readFile(appArchive))
    .digest('hex')
const before = await hash()
let child, pipe
async function command(file, args, environment = env) {
  await new Promise((done, fail) => {
    const process = spawn(file, args, { env: environment, stdio: 'ignore' })
    process.once('error', fail)
    process.once('exit', (code) => (code === 0 ? done() : fail(Error('隔离准备失败：' + code))))
  })
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    await pipe.command('Browser.close')
  } catch {}
  for (let n = 0; n < 100 && child.exitCode === null && child.signalCode === null; n++)
    await delay(100)
  if (child.exitCode === null && child.signalCode === null) {
    process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM')
    for (let n = 0; n < 50 && child.exitCode === null && child.signalCode === null; n++)
      await delay(100)
  }
  if (child.exitCode === null && child.signalCode === null) {
    process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL')
    for (let n = 0; n < 50 && child.exitCode === null && child.signalCode === null; n++)
      await delay(100)
  }
  if (child.exitCode === null && child.signalCode === null) throw Error('隔离应用尚未停止')
}
const savedState = rootArg
  ? JSON.parse(await readFile(join(root, 'state.json'), 'utf8').catch(() => 'null'))
  : undefined
const nonce =
  savedState?.parentId?.replace(/^opl-mixed-/, '') ?? 'OPL_TEAM_' + randomUUID().slice(0, 8)
const daily = parse(
  await readFile(join(homedir(), '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8'),
  { logLevel: 'silent' },
)
const providers = daily.find((row) => row.id === 'llm-pi-ai')?.config.providers
if (!providers?.['opl-gateway-openai']) throw Error('没有可用的真实 Codex 模型配置')
const required = [
  'OPL_GATEWAY_DEEPSEEK_API_KEY',
  'OPL_GATEWAY_CODEX_API_KEY',
  'OPL_GATEWAY_AWS_API_KEY',
]
const credentials = parse(await readFile(join(homedir(), '.dsh/.credentials.yaml'), 'utf8'))
const selectedCredentials = { version: credentials.version, refs: {}, records: {} }
for (const ref of required) {
  const value = credentials.refs[ref]
  if (typeof value !== 'string' || !value) throw Error('缺少验收凭据引用：' + ref)
  selectedCredentials.refs[ref] = value
}
await writeFile(join(root, '.credentials.yaml'), stringify(selectedCredentials), { mode: 0o600 })
const gateway = daily.find((row) => row.id === 'opl-suite')?.config.gateway ?? {}
const basePatch = [
  { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
  { id: 'opl-suite', config: { gateway } },
  {
    id: 'llm-pi-ai',
    config: {
      providers: Object.fromEntries(
        ['opl-gateway-openai', 'opl-gateway-aws']
          .map((id) => [id, providers[id]])
          .filter(([, value]) => value),
      ),
    },
  },
  {
    id: 'agent-default-model',
    config: { provider: 'opl-gateway', model: 'deepseek-flash', reasoningEffort: 'low' },
  },
  { id: 'ui-settings-general', config: { welcomeNoticeVersion: '2026-08-13.1' } },
  { id: 'ui-settings-account', config: { version: 1, step: 'done', completion: 'skipped' } },
  {
    insert: [
      {
        id: 'preset-opl-probe-codex',
        name: '@deepseek-ai/dsh-agent-preset',
        config: {
          id: 'opl-probe-codex',
          name: 'OPL Codex 验证成员',
          plugins: [
            {
              id: 'persona',
              name: '@deepseek-ai/dsh-persona',
              config: {
                prefix:
                  'You are an OPL test developer. Complete the requested file and official team messaging verification.',
              },
            },
            {
              id: 'tool-subagent-control',
              name: '@deepseek-ai/dsh-tool-subagent-control',
              config: { interrupt: true },
            },
          ],
        },
      },
    ],
  },
  {
    insert: [
      {
        id: 'preset-opl-probe-claude',
        name: '@deepseek-ai/dsh-agent-preset',
        config: {
          id: 'opl-probe-claude',
          name: 'OPL Claude 验证成员',
          plugins: [
            {
              id: 'persona',
              name: '@deepseek-ai/dsh-persona',
              config: {
                prefix:
                  'You are an OPL test reviewer. Use the official dsh_* MCP tools for DSH team tasks and messages.',
              },
            },
            {
              id: 'tool-subagent-control',
              name: '@deepseek-ai/dsh-tool-subagent-control',
              config: { interrupt: true },
            },
          ],
        },
      },
    ],
  },
]
basePatch.find((row) => row.id === 'llm-pi-ai').config.providers['probe-independent'] = {
  ...providers['opl-gateway-openai'],
  models: providers['opl-gateway-openai'].models.filter((model) => model.id === 'gpt-6-luna'),
}
try {
  if (!rootArg || process.argv.includes('--reinstall')) {
    if (!rootArg)
      await writeFile(join(profile, 'cordis.patch.yml'), stringify(basePatch), { mode: 0o600 })
    console.log('正在安装隔离插件：' + root)
    await command(
      executable,
      [
        join(repo, 'installer/profile.cjs'),
        app,
        root,
        join(repo, 'dist', artifact.name),
        ...(artifact.plugins ?? []).map((plugin) => '--plugin=' + join(repo, 'dist', plugin.name)),
      ],
      { ...env, ELECTRON_RUN_AS_NODE: '1' },
    )
  }
  const reports = []
  const phases = process.argv
    .find((arg) => arg.startsWith('--phases='))
    ?.slice(9)
    .split(',') ?? ['first', 'resume', 'mixed', 'cancel', 'lifecycle', 'upgrade']
  for (const phase of phases) {
    if (phase === 'upgrade')
      await command(
        executable,
        [
          join(repo, 'installer/profile.cjs'),
          app,
          root,
          join(repo, 'dist', artifact.name),
          ...(artifact.plugins ?? []).map(
            (plugin) => '--plugin=' + join(repo, 'dist', plugin.name),
          ),
        ],
        { ...env, ELECTRON_RUN_AS_NODE: '1' },
      )
    const output = join(root, phase + '.json')
    await rm(output, { force: true })
    const currentPatch = parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), {
      logLevel: 'silent',
    })
    const retainedPatch = currentPatch.filter(
      (row) => !row.insert?.some((item) => item.id === 'opl-mixed-team-probe'),
    )
    const patch = [
      ...retainedPatch,
      {
        insert: [
          {
            id: 'opl-mixed-team-probe',
            name: join(
              repo,
              'scripts/fixtures',
              ['lifecycle', 'upgrade', 'ui'].includes(phase)
                ? 'split-plugin-probe.mjs'
                : 'mixed-team-probe.mjs',
            ),
            config: {
              output,
              state: join(root, 'state.json'),
              workspace,
              phase,
              nonce,
              parentId: 'opl-mixed-' + nonce,
            },
          },
        ],
      },
    ]
    await writeFile(join(profile, 'cordis.patch.yml'), stringify(patch), { mode: 0o600 })
    const { ELECTRON_RUN_AS_NODE: _, ...desktopEnv } = env
    child = spawn(
      executable,
      ['--user-data-dir=' + join(root, 'electron'), '--remote-debugging-pipe'],
      {
        env: desktopEnv,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      },
    )
    pipe = new DesktopPipe(child)
    console.log('正在验证真实团队：' + phase)
    const until = Date.now() + 240000
    let report
    while (Date.now() < until) {
      report = JSON.parse(await readFile(output, 'utf8').catch(() => 'null'))
      if (report) break
      if (child.exitCode !== null) throw Error('隔离桌面提前退出')
      // Complete only the owned fresh Desktop's official welcome gate.
      const targets = await pipe.command('Target.getTargets').catch(() => ({ targetInfos: [] }))
      for (const target of targets.targetInfos.filter(
        (item) => item.type === 'page' && /welcome/i.test(item.url),
      )) {
        const { sessionId } = await pipe.command('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        })
        try {
          await pipe.evaluate(
            sessionId,
            "(() => {const labels=['添加 API Key','Add API Key','稍后配置','Set up later','Configure later','Skip for now'];const button=Array.from(document.querySelectorAll('button')).find(x=>x.getClientRects().length&&labels.includes((x.textContent||'').trim()));button?.click()})()",
          )
        } finally {
          await pipe.command('Target.detachFromTarget', { sessionId }).catch(() => {})
        }
      }
      await delay(1000)
    }
    if (report?.status === 'passed' && ['first', 'presentation', 'ui'].includes(phase)) {
      report.presentation = await verifyPluginPresentation(
        pipe,
        join(repo, 'dist/mixed-team-plugins'),
      )
      report.roleUi = await verifyRoleClient(pipe, join(repo, 'dist/mixed-team-roles.png'))
    }
    await stop()
    if (!report) throw Error('真实成员验收超时，隔离资料保留：' + root)
    reports.push(report)
    if (report.status !== 'passed') throw Error(report.failure)
    console.log(JSON.stringify(report))
  }
  if ((await hash()) !== before) throw Error('官方应用资源发生变化')
  await writeFile(
    join(repo, 'dist/mixed-team-qualification.json'),
    JSON.stringify(
      { status: 'passed', platform: process.platform, officialAppSha256: before, reports },
      null,
      2,
    ) + '\n',
  )
  if (!process.argv.includes('--keep')) await rm(root, { recursive: true, force: true })
} catch (error) {
  console.error(error.message)
  console.error('隔离目录：' + root)
  process.exitCode = 1
} finally {
  await stop()
}
