import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { oplProfileDirectory } from '../../src/shared/host/profile-paths.ts'
import { ExecutionCatalogStore } from '../../src/execution/host/catalog.ts'

const roots: string[] = []
async function temporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  roots.push(home)
  return home
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('OPL profile paths', () => {
  it('retains the desktop default when the launcher supplies no profile', () => {
    const home = join(tmpdir(), 'opl-profile-default-home')
    expect(oplProfileDirectory(home, {})).toBe(join(home, 'profiles', 'desktop'))
    expect(oplProfileDirectory(undefined, { DSH_HOME: home })).toBe(
      join(home, 'profiles', 'desktop'),
    )
    expect(oplProfileDirectory(home, { DSH_PROFILE: ' ', DSH_PROFILE_DIR: ' ' })).toBe(
      join(home, 'profiles', 'desktop'),
    )
  })

  it('uses the launched profile name when no absolute directory is supplied', () => {
    const home = join(tmpdir(), 'opl-profile-named-home')
    expect(oplProfileDirectory(undefined, { DSH_HOME: home, DSH_PROFILE: 'opl-linux' })).toBe(
      join(home, 'profiles', 'opl-linux'),
    )
  })

  it('prefers the explicit OPL profile over an inherited web environment', () => {
    const home = join(tmpdir(), 'opl-profile-explicit-home')
    const env = {
      DSH_HOME: home,
      DSH_PROFILE: 'web',
      DSH_PROFILE_DIR: join(home, 'profiles', 'web'),
      OPL_PROFILE_NAME: 'opl-linux',
    }
    expect(oplProfileDirectory(undefined, env)).toBe(join(home, 'profiles', 'opl-linux'))
    expect(oplProfileDirectory(home, env)).toBe(join(home, 'profiles', 'opl-linux'))
  })

  it('prefers the launchers absolute profile directory', () => {
    const home = join(tmpdir(), 'opl-profile-directed-home')
    const profile = join(home, 'profiles', 'opl-linux')
    const env = { DSH_HOME: home, DSH_PROFILE: 'opl-linux', DSH_PROFILE_DIR: profile }
    expect(oplProfileDirectory(undefined, env)).toBe(profile)
    expect(oplProfileDirectory(home, env)).toBe(profile)
  })

  it('does not let an ambient profile escape an explicit temporary home', () => {
    const home = join(tmpdir(), 'opl-profile-isolated-home')
    const outside = join(tmpdir(), 'opl-profile-outside-home', 'profiles', 'web')
    expect(oplProfileDirectory(home, { DSH_PROFILE: 'web', DSH_PROFILE_DIR: outside })).toBe(
      join(home, 'profiles', 'desktop'),
    )
  })

  it('rejects a relative launcher profile directory', () => {
    expect(() => oplProfileDirectory(undefined, { DSH_PROFILE_DIR: 'profiles/opl-linux' })).toThrow(
      'DSH_PROFILE_DIR 必须是绝对路径',
    )
  })
})

describe('ExecutionCatalogStore profile persistence', () => {
  it('writes the launched profile and keeps an explicit home isolated', async () => {
    const home = await temporaryHome('opl-profile-live-home-')
    const profile = join(home, 'profiles', 'opl-linux')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('DSH_PROFILE', 'opl-linux')
    vi.stubEnv('DSH_PROFILE_DIR', profile)

    const launched = new ExecutionCatalogStore()
    expect(launched.filename).toBe(join(profile, 'execution-catalog.json'))
    await launched.set(await launched.get())
    await launched.dispose()
    expect(JSON.parse(await readFile(launched.filename, 'utf8')).version).toBe(2)

    const isolatedHome = await temporaryHome('opl-profile-live-isolated-')
    const isolated = new ExecutionCatalogStore(isolatedHome)
    expect(isolated.filename).toBe(
      join(isolatedHome, 'profiles', 'desktop', 'execution-catalog.json'),
    )
    await isolated.set(await isolated.get())
    await isolated.dispose()
    expect(JSON.parse(await readFile(isolated.filename, 'utf8')).version).toBe(2)
  })
})
