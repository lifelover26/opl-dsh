/** Windows shell selection for the MiniMax CLI, independent of the DSH shell service. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { win32 } from 'node:path'
import { resolveGitBashPath } from '../../../shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../acp.ts'
import type { AcpSessionSnapshot } from './types.ts'

const exec = promisify(execFile)

/** Resolve and execute the selected Git Bash before launching an ACP process. */
export async function minimaxBashEnvironment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'win32') return env
  const shell = resolveGitBashPath()
  try {
    const result = await exec(
      shell,
      ['--noprofile', '--norc', '-c', 'printf "OPL_GIT_BASH:"; /usr/bin/uname -s'],
      {
        env,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 4096,
      },
    )
    if (!/^OPL_GIT_BASH:(?:MINGW(?:32|64)|MSYS)_NT-/.test(result.stdout.trim()))
      throw Error('Unexpected shell')
  } catch {
    throw new HarnessConfigurationError(
      'MiniMax Git Bash 启动验证失败。请安装 Git for Windows 或将 OPL_GIT_BASH_PATH 指向可运行的 bash.exe；未启动 mcode，未发送任务。',
    )
  }
  return { ...env, MCODE_SHELL_PATH: shell, SHELL: shell }
}

/** Refuse a CLI which ignored the requested shell, including after process recovery. */
export function verifyMinimaxBash(snapshot: AcpSessionSnapshot): void {
  if (process.platform !== 'win32') return
  const advertised = snapshot.agent?._meta?.['minimax-code/shell']
  const expected = resolveGitBashPath()
  if (
    advertised?.version !== 1 ||
    advertised.type !== 'bash' ||
    typeof advertised.shell !== 'string' ||
    win32.normalize(advertised.shell).toLowerCase() !== win32.normalize(expected).toLowerCase() ||
    !Array.isArray(advertised.args) ||
    advertised.args.length !== 1 ||
    advertised.args[0] !== '-c'
  ) {
    throw new HarnessConfigurationError(
      'MiniMax Code 未确认所要求的 Git Bash 后端。请配置已验证的 MCode 候选启动器（0.7.4 + OPL），或具备相同 ACP shell 回读的版本。已停止，未发送任务，不回退 PowerShell、CMD 或 WSL。',
    )
  }
}
