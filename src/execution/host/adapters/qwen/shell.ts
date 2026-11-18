/** Select the official Qwen Code Windows Git Bash branch and verify its executable. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { win32 } from 'node:path'
import { resolveNativeGitBash } from '../native-bash.ts'
const exec = promisify(execFile)

/** Resolve a real Git Bash before setting the variables Qwen's shell resolver reads. */
export async function qwenShellEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<NodeJS.ProcessEnv> {
  if (platform !== 'win32') return { ...env }
  const bash = resolveNativeGitBash({ env, platform })
  if (!bash) throw Error('Qwen Code 需要 Git for Windows Bash，未启动 CLI。')
  const probe = await exec(
    bash,
    ['--noprofile', '--norc', '-c', 'printf "OPL_QWEN_BASH:%s\n" "$BASH_VERSION"; uname -s'],
    {
      env,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4096,
    },
  )
  if (!/^OPL_QWEN_BASH:\d+\./m.test(probe.stdout) || !/^MINGW[^\r\n]*$/m.test(probe.stdout))
    throw Error('Qwen Code 未确认可用的 Windows Git Bash，未启动 CLI。')
  // Qwen 0.27.3 checks MSYSTEM then selects the first PATH bash.exe.
  return {
    ...env,
    MSYSTEM: 'MINGW64',
    PATH: `${win32.dirname(bash)};${env.PATH ?? ''}`,
    SHELL: bash,
  }
}
