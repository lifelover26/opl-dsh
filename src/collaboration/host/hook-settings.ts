import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CoordinatorHooksStatus } from '../../contracts/types.ts'

type Definition = { command: string; commandWindows?: string }
type Definitions = Record<string, { hooks: Definition[] }[]>
type Listed = {
  eventName: string
  sourcePath: string
  command?: string
  enabled: boolean
  trustStatus: string
}
const lower = (s: string) => s.toLowerCase()
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? lower(resolve(a)) === lower(resolve(b)) : resolve(a) === resolve(b)

async function listHooks(home: string, executable: string): Promise<Listed[]> {
  return new Promise((ok, reject) => {
    const p = spawn(executable, ['app-server'], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const lines = createInterface({ input: p.stdout })
    const finish = () => {
      clearTimeout(timer)
      lines.close()
      p.stdin.end()
      p.kill()
    }
    const fail = () => {
      reject(new Error('Codex Hook 状态不可用'))
      finish()
    }
    const timer = setTimeout(fail, 10000)
    p.once('error', fail)
    p.once('close', () => {
      clearTimeout(timer)
      reject(new Error('Codex 已退出'))
    })
    p.stdin.on('error', fail)
    const send = (v: object) => p.stdin.write(JSON.stringify(v) + '\n')
    lines.on('line', (line) => {
      try {
        const m = JSON.parse(line)
        if (m.id === 1 && m.result) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'hooks/list', params: { cwds: [home] } })
        } else if (m.id === 2 && Array.isArray(m.result?.data?.[0]?.hooks)) {
          ok(m.result.data[0].hooks)
          finish()
        } else if (m.error) fail()
      } catch {
        fail()
      }
    })
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'opl_hook_settings', version: '1' } },
    })
  })
}

export async function coordinatorHooks(
  skillDir: string,
  action: 'status' | 'install' | 'remove',
): Promise<CoordinatorHooksStatus> {
  const home = dirname(dirname(skillDir)),
    root = join(home, 'opl-dsh-coordinator'),
    file = join(home, 'hooks.json')
  if (action !== 'status') {
    let output
    try {
      output = await promisify(execFile)(
        process.execPath,
        [
          join(skillDir, 'coordinator', 'cli.mjs'),
          action === 'install' ? 'setup' : 'remove-hooks',
          '--codex-home',
          home,
          '--root',
          root,
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30000 },
      )
    } catch {
      throw new Error('未完成 Hook 配置，请检查协调器安装及文件权限。')
    }
    const result = JSON.parse(output.stdout)
    if (result.reason === 'node-runtime-required')
      throw new Error('请先安装 Node.js，再安装 Hook。')
    if (!['installed', 'unchanged', 'not-installed', 'removed'].includes(result.status))
      throw new Error('已有 Hook 配置与安装记录不一致，请先在 Codex 中检查。')
  }
  const status: CoordinatorHooksStatus = {
    installed: false,
    total: 0,
    registered: 0,
    verified: 0,
    trusted: 0,
    disabled: 0,
  }
  let meta
  try {
    meta = JSON.parse(await readFile(join(root, 'hooks-installation.json'), 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return status
    throw e
  }
  if (!samePath(meta.hooksPath, file)) throw new Error('Hook 安装记录与当前 Codex 目录不一致。')
  status.installed = true
  const definitions: Definitions = meta.backups.at(-1).owned.hooks
  const actual: Definitions =
    JSON.parse(
      await readFile(file, 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return '{}'
        throw e
      }),
    ).hooks ?? {}
  let listed = await listHooks(home, process.platform === 'win32' ? 'codex.exe' : 'codex').catch(
    () => [],
  )
  if (
    process.platform === 'win32' &&
    !listed.some((h) => h.sourcePath && samePath(h.sourcePath, file))
  ) {
    const script =
      "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | Where-Object { $_.CommandLine -match '\\bapp-server\\b' -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid } | Select-Object -ExpandProperty ExecutablePath -Unique"
    const shell = join(
      process.env.SystemRoot ?? 'C:/Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    )
    const paths = (
      await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 6000,
      }).catch(() => ({ stdout: '' }))
    ).stdout
      .trim()
      .split(/\r?\n/)
    if (paths.length === 1 && /^[A-Za-z]:[\\/].*[\\/]codex\.exe$/i.test(paths[0]!))
      listed = await listHooks(home, paths[0]!).catch(() => [])
  }
  for (const [event, groups] of Object.entries(definitions))
    for (const def of groups.flatMap((g) => g.hooks)) {
      status.total++
      if (
        (actual[event] ?? [])
          .flatMap((g) => g.hooks)
          .filter((h) => h.command === def.command && h.commandWindows === def.commandWindows)
          .length !== 1
      )
        continue
      status.registered++
      const found = listed.filter(
        (h) =>
          h.sourcePath &&
          samePath(h.sourcePath, file) &&
          lower(h.eventName) === lower(event) &&
          (h.command === def.command ||
            (def.commandWindows !== undefined && h.command === def.commandWindows)),
      )
      if (found.length !== 1) continue
      const h = found[0]!
      if (!['trusted', 'untrusted', 'modified', 'managed'].includes(h.trustStatus)) continue
      status.verified++
      if (h.trustStatus === 'trusted' || h.trustStatus === 'managed') status.trusted++
      if (!h.enabled) status.disabled++
    }
  return status
}
