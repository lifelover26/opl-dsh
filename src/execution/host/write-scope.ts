/** Declared write ownership for scheduling; this is not filesystem confinement. */
import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const key = (path: string) => {
  const value = path.replaceAll('\\', '/').replace(/\/$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** Resolve existing ancestors so symlink aliases and not-yet-created files share one lock. */
function canonical(path: string): string {
  const tail: string[] = []
  let parent = path
  while (true) {
    try {
      return key(resolve(realpathSync(parent), ...tail))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      const next = dirname(parent)
      if (next === parent) throw error
      tail.unshift(basename(parent))
      parent = next
    }
  }
}

/** Validate queued/file input and persist canonical absolute paths for one operation. */
export async function resolveWriteScope(
  cwd: string,
  value: unknown,
): Promise<string[] | undefined> {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((path) => typeof path !== 'string' || !path.trim() || /[\0*?]/.test(path))
  )
    throw Error('writeScope 必须为非空精确路径数组；不接受通配符')
  return [
    ...new Set(await Promise.all(value.map((path: string) => canonical(resolve(cwd, path))))),
  ].sort()
}

/** Directory scopes include descendants; sibling filenames never overlap by prefix alone. */
export function writeScopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) =>
    right.some((b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')),
  )
}

/**
 * Only two explicitly declared, overlapping scopes contend.
 *
 * An omitted scope means "not declared", not ownership of the whole cwd. Treating every
 * unscoped writer in one project as exclusive turns normal parallel sessions into an
 * implicit queue and has no official DSH counterpart. Explicit scopes may still protect
 * a shared output; isolated Git work uses the official worktree owner instead.
 */
export function writerConflicts(
  left: { cwd: string; writeScope?: readonly string[] | undefined },
  right: { cwd: string; writeScope?: readonly string[] | undefined },
): boolean {
  if (!left.writeScope || !right.writeScope) return false
  return writeScopesOverlap(left.writeScope, right.writeScope)
}
