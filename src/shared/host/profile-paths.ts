/** Resolve OPL-owned files against the profile that launched the official Host. */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const DEFAULT_PROFILE = 'desktop'
type ProfileEnvironment = Record<string, string | undefined>

function contains(home: string, candidate: string): boolean {
  const child = relative(home, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/**
 * Use the launcher's absolute profile directory when available. Desktop has no
 * launcher profile environment and retains its historical `desktop` location.
 * An explicit home is an isolation boundary: an ambient profile directory
 * outside it is ignored so tests and legacy callers cannot write another profile.
 */
export function oplProfileDirectory(home?: string, env: ProfileEnvironment = process.env): string {
  const resolvedHome = resolveDshHome(home, env)
  const explicitProfile = env.OPL_PROFILE_NAME?.trim()
  if (explicitProfile) {
    if (!/^[a-z][a-z0-9-]*$/u.test(explicitProfile) || explicitProfile === 'desktop')
      throw Error('OPL_PROFILE_NAME 必须是非 desktop 的有效 CLI profile')
    return join(resolvedHome, 'profiles', explicitProfile)
  }
  const launched = env.DSH_PROFILE_DIR?.trim()
  if (launched) {
    if (!isAbsolute(launched)) throw Error('DSH_PROFILE_DIR 必须是绝对路径')
    const directory = resolve(launched)
    if (home === undefined || contains(resolvedHome, directory)) return directory
    return join(resolvedHome, 'profiles', DEFAULT_PROFILE)
  }
  return join(resolvedHome, 'profiles', env.DSH_PROFILE?.trim() || DEFAULT_PROFILE)
}

/** Join an OPL-owned relative path onto the current profile directory. */
export function oplProfilePath(home: string | undefined, ...segments: string[]): string {
  return join(oplProfileDirectory(home), ...segments)
}
