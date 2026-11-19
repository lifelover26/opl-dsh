/** Access only the current profile's installation receipt and updater-owned files. */
import { readFile, writeFile, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { installationPaths } from '../../../installer/installation-paths.mjs'
import type { Context } from '@deepseek-ai/cordis'
import type { OplUpdatePolicy, OplUpdateRelease, OplUpdateStatus } from '../contracts.ts'
import type { InstalledUpdateIdentity, UpdateOperations } from './controller.ts'
import { defaultUpdatePolicy, storedUpdatePolicy } from './idle.ts'
import type {} from './runtime-admission.ts'

interface Installed extends InstalledUpdateIdentity {
  suiteRoot: string
  app: string
  release: string
  suiteSha256: string
  profileHome: string
  skillDir: string
}
interface Updater {
  readOfficialVersion(application: string): string
  checkRelease(
    current: InstalledUpdateIdentity,
    options: { signal: AbortSignal },
  ): Promise<{ release: OplUpdateRelease | null }>
  readPreparedUpdate(
    root: string,
    officialVersion?: string,
  ): Promise<{ version: string; preparedAt: string } | null>
  prepareUpdate(
    root: string,
    app: string,
    options: { signal: AbortSignal; expectedVersion: string },
  ): Promise<unknown>
  cancelPreparedUpdate(root: string): Promise<void>
}

/** Preserve a failed launch for its current pending plan, including after a cache reset. */
export function restoreLaunchFailure(
  stored: unknown,
  outcome: unknown,
  pending: { preparedAt: string } | null,
  current: InstalledUpdateIdentity,
): unknown {
  if (!outcome || typeof outcome !== 'object' || !pending) return stored
  const result = outcome as { state?: unknown; checkedAt?: unknown }
  if (result.state !== 'deferred' || typeof result.checkedAt !== 'string') return stored
  const failedAt = Date.parse(result.checkedAt)
  const preparedAt = Date.parse(pending.preparedAt)
  if (!Number.isFinite(failedAt) || !Number.isFinite(preparedAt) || failedAt < preparedAt)
    return stored
  const row = stored && typeof stored === 'object' ? (stored as Partial<OplUpdateStatus>) : {}
  return {
    ...(row.installedVersion === current.suiteVersion &&
    row.officialVersion === current.officialVersion
      ? row
      : {}),
    installedVersion: current.suiteVersion,
    officialVersion: current.officialVersion,
    error: 'prepare-failed',
    failure: { stage: 'apply', reason: 'unknown' },
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
      return null
    throw error
  }
}

/** The installed release owns its matching installer implementation. */
export function updateOperations(ctx: Context): UpdateOperations {
  let armed: string | undefined
  const installation = async (): Promise<Installed> => {
    const profile = dshHomePath()
    return installationPaths(
      JSON.parse(await readFile(join(profile, 'opl-dsh/installation.json'), 'utf8')),
      { profileHome: profile },
    ) as Installed
  }
  const updater = async (installed: Installed): Promise<Updater> =>
    (await import(pathToFileURL(join(installed.release, 'update.mjs')).href)) as Updater
  let versionCache: { key: string; version: string } | undefined
  const actualInstallation = async (): Promise<Installed> => {
    const receipt = await installation()
    if (process.platform !== 'win32' && process.platform !== 'darwin') return receipt
    const archive = join(
      receipt.app,
      process.platform === 'win32' ? 'resources' : 'Contents/Resources',
      'app.asar',
    )
    const file = await stat(archive, { bigint: true })
    const key = [archive, file.ino, file.size, file.ctimeNs, file.mtimeNs].join(':')
    if (versionCache?.key !== key)
      versionCache = { key, version: (await updater(receipt)).readOfficialVersion(receipt.app) }
    return { ...receipt, officialVersion: versionCache.version }
  }
  const desktop = async (
    installed: Installed,
    method: string,
    input: object = {},
  ): Promise<unknown> => {
    const bridge = (await import(
      pathToFileURL(join(installed.release, 'desktop-update.mjs')).href
    )) as {
      requestDesktopUpdate(
        root: string,
        identity: object,
        method: string,
        input: object,
      ): Promise<unknown>
    }
    return bridge.requestDesktopUpdate(installed.suiteRoot, installed, method, {
      ...input,
      hostPid: process.pid,
    })
  }
  return {
    installed: actualInstallation,
    automatic: () => {
      const value = ctx.settings.describe().find((entry) => entry.ns === 'opl-suite')?.value as
        { updateAutomatic?: boolean } | undefined
      return value?.updateAutomatic !== false
    },
    saveAutomatic: (enabled) => ctx.settings.update('opl-suite', { updateAutomatic: enabled }),
    policy: () => {
      const value = ctx.settings
        .describe({ redactSecrets: true })
        .find((entry) => entry.ns === 'opl-suite')?.value as
        { updatePolicy?: unknown; updatePolicyChosen?: unknown } | undefined
      return value === undefined ? { ...defaultUpdatePolicy } : storedUpdatePolicy(value)
    },
    savePolicy: (policy: OplUpdatePolicy) =>
      ctx.settings.update('opl-suite', { updatePolicy: policy, updatePolicyChosen: true }),
    inspect: async () => {
      if (!(await ctx.oplUpdateRuntime.inspect())) return 'busy'
      const current = await installation()
      try {
        const state = (await desktop(current, 'inspect')) as {
          available: boolean
          otherProfile?: boolean
        }
        if (state.otherProfile) return 'other-profile'
        return state.available ? null : 'desktop-unavailable'
      } catch {
        return 'desktop-unavailable'
      }
    },
    handoff: async () => {
      const release = await ctx.oplUpdateRuntime.freeze()
      try {
        const current = await installation()
        const value = (await desktop(current, 'prepare')) as { id: string; nonce: string }
        if (!value || !/^[a-f0-9-]{36}$/.test(value.id) || !/^[a-f0-9-]{36}$/.test(value.nonce))
          throw Error('Invalid update handoff')
        ctx.oplUpdateRuntime.shutdownTarget({
          root: current.suiteRoot,
          id: value.id,
          nonce: value.nonce,
        })
        await desktop(current, 'handoff', { id: value.id, transactionNonce: value.nonce })
        const guard = setTimeout(() => {
          release()
          ctx.oplUpdateRuntime.failed()
        }, 45_000)
        guard.unref()
        ctx.effect(() => () => clearTimeout(guard))
      } catch (error) {
        release()
        throw error
      }
    },
    load: async () => {
      const installed = await actualInstallation()
      const stored = await readJson(join(installed.suiteRoot, 'update-status.json'))
      const outcome = await readJson(join(installed.suiteRoot, 'enhancement-update.json'))
      let pending
      try {
        pending = await (
          await updater(installed)
        ).readPreparedUpdate(installed.suiteRoot, installed.officialVersion)
      } catch {
        return stored
      } // The controller reports malformed pending plans separately.
      return restoreLaunchFailure(stored, outcome, pending, installed)
    },
    save: async (status: OplUpdateStatus) => {
      const installed = await installation()
      const file = join(installed.suiteRoot, 'update-status.json')
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(status) + '\n', { mode: 0o600, flag: 'wx' })
        await rename(temporary, file)
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    },
    discover: async (current, signal) => {
      const installed = await installation()
      return (await (await updater(installed)).checkRelease(current, { signal })).release
    },
    pending: async () => {
      const installed = await actualInstallation()
      const pending = await (
        await updater(installed)
      ).readPreparedUpdate(installed.suiteRoot, installed.officialVersion)
      if (!pending) armed = undefined
      return pending?.version ?? null
    },
    armPending: async () => {
      const installed = await actualInstallation()
      const pending = await (
        await updater(installed)
      ).readPreparedUpdate(installed.suiteRoot, installed.officialVersion)
      if (!pending) return
      const identity = `${pending.version}:${pending.preparedAt}`
      if (armed === identity) return
      const watcher = (await import(
        pathToFileURL(join(installed.release, 'post-exit-update.mjs')).href
      )) as {
        armPostExitUpdate(input: object): Promise<boolean>
      }
      if (
        await watcher.armPostExitUpdate({
          root: installed.suiteRoot,
          application: installed.app,
          profileHome: installed.profileHome,
          skillDir: installed.skillDir,
          hostPid: process.pid,
          desktopPid: process.ppid,
        })
      )
        armed = identity
    },
    prepare: async (signal, expectedVersion) => {
      const installed = await installation()
      await (
        await updater(installed)
      ).prepareUpdate(installed.suiteRoot, installed.app, { signal, expectedVersion })
    },
    cancel: async () => {
      const installed = await installation()
      await (await updater(installed)).cancelPreparedUpdate(installed.suiteRoot)
    },
  }
}
