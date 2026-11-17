/** Launch official Desktop outside the calling Windows Job through WMI.
 * Win32_Process.Create does not inherit the caller's Job. It also does not carry
 * a custom environment block: Windows callers pass profile paths through the
 * Suite launch.vbs arguments. Broker failures refuse the start.
 * @see https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
 */
import { spawn, spawnSync } from 'node:child_process'

/**
 * Build the Suite's Windows launcher with explicit profile and Codex paths.
 * WMI does not inherit the caller's environment; CODEX_HOME selects the state
 * database used by the configured Codex queue executable.
 * @param options - application, setup, profile, Suite and Codex home paths.
 * @returns a Windows Script Host launcher; paths are quoted as VBS literals.
 */
export function windowsSuiteLauncher({ executable, setup, home, root, app, codexHome }) {
  const literal = (value) => '"' + value.replaceAll('"', '""') + '"'
  const command = [executable, setup, home, root, app].map(quoteWindowsArgument).join(' ')
  return [
    'Set shell = CreateObject("WScript.Shell")',
    'shell.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"',
    'shell.Environment("Process")("CODEX_HOME") = ' + literal(codexHome),
    'shell.Run ' + literal(command) + ', 0, False',
    '',
  ].join('\r\n')
}

/** Quote one argument for the CommandLineToArgvW parser CreateProcessW expects. */
export function quoteWindowsArgument(value) {
  const text = String(value)
  if (text.length > 0 && !/[\s"]/.test(text)) return text
  let quoted = '"'
  let backslashes = 0
  for (const character of text) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    quoted += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"'
}

// Win32_Process.Create is executed by the WMI provider, which is not inside the
// caller's Job, so the new process is not either. Same user, no service, no
// scheduled task, no elevation. It takes no environment block, so callers on
// this path must carry their state in argv.
const wmiScript = `
$ErrorActionPreference = 'Stop'
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $env:OPL_LAUNCH_COMMANDLINE
  CurrentDirectory = $env:OPL_LAUNCH_DIRECTORY
}
Write-Output ('RET:' + $result.ReturnValue)
Write-Output ('PID:' + $result.ProcessId)
`

function runHelper(script, env) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        env: Object.fromEntries(
          Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
        ),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
      },
    )
    return {
      ok: result.status === 0,
      output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      error: result.error?.message,
    }
  } catch (error) {
    return { ok: false, output: '', error: String(error) }
  }
}

function spawnInherited(command, args, env, stdio) {
  const child = spawn(command, args, { env, detached: true, stdio })
  child.unref()
  return child
}

/**
 * Start a Windows process through WMI, or a detached POSIX process.
 * @param options - executable, argv, helper environment, diagnostic label and optional POSIX stdio.
 * @returns launch PID and method, or an explicit Windows refusal; envApplied
 * reports whether the target receives the supplied environment.
 */
export function launchIndependent({
  command,
  args = [],
  env = process.env,
  label,
  stdio = 'ignore',
}) {
  if (process.platform !== 'win32') {
    const pid = spawnInherited(command, args, env, stdio).pid
    return {
      pid,
      method: 'posix-inherit',
      guarantee: 'not-applicable',
      envApplied: true,
      label: label ?? null,
    }
  }

  const commandLine = [command, ...args].map(quoteWindowsArgument).join(' ')
  const broker = runHelper(wmiScript, {
    ...env,
    OPL_LAUNCH_COMMANDLINE: commandLine,
    OPL_LAUNCH_DIRECTORY: process.cwd(),
  })
  const returnValue = /RET:(\d+)/.exec(broker.output)
  const created = /PID:(\d+)/.exec(broker.output)

  if (broker.ok && created && Number(created[1]) > 0 && returnValue && returnValue[1] === '0')
    return {
      pid: Number(created[1]),
      method: 'wmi-broker',
      // Documented, not inferred: children created through Win32_Process.Create
      // are not associated with the calling process's Job.
      guarantee: 'job-independent',
      // Win32_Process.Create takes no environment block; state must travel in argv.
      envApplied: false,
      label: label ?? null,
      wmiReturnValue: Number(returnValue[1]),
    }

  const reason =
    '无法启动与调用方 Job 独立的进程：Win32_Process.Create 返回 ' +
    (returnValue ? 'ReturnValue=' + returnValue[1] : (broker.error ?? 'helper-failed')) +
    '。本辅助入口不会退回到与 Codex 共享的 Job，请改用桌面「OPL DSH」快捷方式启动。'
  return { pid: null, method: 'refused', guarantee: 'none', envApplied: false, refusal: reason }
}
