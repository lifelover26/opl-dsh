import { describe, expect, it } from 'vitest'
import { qwenShellEnvironment } from '../../../src/execution/host/adapters/qwen/shell.ts'
describe('Qwen Code shell selection', () => {
  it('preserves POSIX variables without introducing a Windows resolver branch', async () => {
    const env = { PATH: '/bin', SHELL: '/bin/zsh' }
    const result = await qwenShellEnvironment(env, 'darwin')
    expect(result).toEqual(env)
    expect(result).not.toBe(env)
    expect(result.MSYSTEM).toBeUndefined()
  })
  it('refuses an explicitly missing Bash instead of silently selecting cmd or WSL', async () => {
    await expect(
      qwenShellEnvironment(
        { OPL_GIT_BASH_PATH: 'C:/opl-missing-qwen-bash/bash.exe', PATH: '' },
        'win32',
      ),
    ).rejects.toThrow(/no fallback/)
  })
})
