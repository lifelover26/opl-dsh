/** Use MCode 0.7.4's native per-session Windows shell binding. */
import { win32 } from 'node:path'

const samePath = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
const preferenceKey = 'agent-command-shell-preference'

/** Select Git Bash for this ACP runtime without changing the user's CLI preference. */
export async function bindNativeShell(runtime, executable, platform = process.platform) {
  if (platform !== 'win32') return { advertisement: undefined, verify: async () => {} }
  if (!executable || !win32.isAbsolute(executable))
    throw Error('MCODE_SHELL_PATH must be an absolute Git Bash path.')
  const service = runtime.host.cliService.options.agentShell
  if (!service?.options?.preferences || typeof service.resolveForExecution !== 'function')
    throw Error('Pinned MCode native shell service is unavailable.')
  const preferences = service.options.preferences
  service.options.preferences = {
    get: (key) => (key === preferenceKey ? 'git-bash' : preferences.get(key)),
    set: (key, value) => {
      if (key !== preferenceKey) return preferences.set(key, value)
      if (value !== 'git-bash')
        throw Error('The requested Git Bash is unavailable; shell fallback is forbidden.')
    },
  }
  const status = await service.status(true)
  if (
    status.preference !== 'git-bash' ||
    status.effective?.family !== 'git-bash' ||
    !samePath(status.effective.executablePath, executable)
  )
    throw Error('Native MCode did not select the requested Git Bash executable.')
  const verify = async (sessionId) => {
    const bound = await service.resolveForExecution(sessionId)
    if (bound.family !== 'git-bash' || !samePath(bound.executablePath, executable))
      throw Error('The MCode session is bound to a different shell; no task was sent.')
  }
  const create = runtime.adapter.createSession.bind(runtime.adapter)
  runtime.adapter.createSession = async (...args) => {
    const session = await create(...args)
    await verify(session.sessionId)
    return session
  }
  return { verify, advertisement: { version: 1, type: 'bash', shell: executable, args: ['-c'] } }
}
