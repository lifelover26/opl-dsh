import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { executablePath } from '../harness-registry.ts'
import type { HarnessSession } from '../../contracts/sessions.ts'
import type { AdapterOptions, AdapterLaunch } from './types.ts'
import { systemEnvironment } from './environment.ts'
import { codexGitBashOptIn, resolveNativeGitBash } from './native-bash.ts'
import { verifySelectedCodexRuntime } from '../codex-runtime.ts'
import { ExternalModelSources } from '../model-sources.ts'
export async function nativeAvailable(name: string, id: string, options: AdapterOptions) {
  if (id === 'codex' && options.codexRuntime) {
    try {
      verifySelectedCodexRuntime(options.home, options.codexRuntime, options.command ?? '')
    } catch {
      return { available: false, reason: 'Codex Git Bash 候选文件校验失败，请重新选择运行时' }
    }
  }
  return (await executablePath(options.command || id))
    ? { available: true }
    : { available: false, reason: `未找到官方 ${name}，请在 Harness 页检查安装` }
}
/**
 * Whether this record asks the official Harness for its own Auto Review route.
 *
 * The Auto permission preset is published as the `externalAutoReview` flag on the frozen
 * `HarnessSession` record. Only the literal `true` enables the route; absent and `false`
 * both mean "not an Auto session", which keeps every read-only / workspace / full-access
 * session on its current path.
 *
 * A value that is present but not a boolean is a wiring fault, not a permission decision, so
 * it refuses the launch. The persisted form is re-validated here even though the store also
 * checks it on read: quietly treating it as `false` could run an Auto session as an ordinary
 * full-access or never-ask session, which is exactly the silent downgrade this flag exists
 * to prevent.
 * @param record - the persisted session record being launched.
 * @returns true only when the record explicitly asks for the official Auto Review route.
 * @throws when the flag is present and is not a boolean.
 */
export function externalAutoReviewRequested(record: HarnessSession): boolean {
  const value: unknown = record.externalAutoReview
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw Error('Auto Review 标记不是布尔值，拒绝启动官方 Harness')
  return value
}
export async function prepareNative(
  ctx: Context,
  record: HarnessSession,
  options: AdapterOptions,
  environment: (home: string, base: string, key: string) => NodeJS.ProcessEnv,
): Promise<AdapterLaunch> {
  if (record.harnessRef === 'codex' && options.codexRuntime) {
    if (record.sandbox !== 'full-access')
      throw Error('Codex Git Bash 候选仅支持已授权的 full-access；未改变权限')
    verifySelectedCodexRuntime(options.home, options.codexRuntime, options.command ?? '')
  }
  const route = await (options.modelSources ?? new ExternalModelSources(ctx)).resolve(
    record.harnessRef,
    record.modelRef,
    record.harnessRef === 'codex' ? 'responses' : 'messages',
  )
  const command = await executablePath(options.command || record.harnessRef)
  if (!command) throw Error('未找到官方 Harness 程序')
  const key = route.apiKey
  const home = join(options.home, 'harnesses', record.harnessRef, record.id)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const base = route.baseURL
  // The bridge child runs with the reduced suite environment, which drops ProgramFiles, so
  // resolve Git Bash here where the full environment is visible and hand the path down. An
  // explicit but unusable OPL_GIT_BASH_PATH is rejected before a session is ever launched.
  const gitBash = resolveNativeGitBash()
  // Read before building the environment: a malformed flag must refuse the launch rather
  // than start a session whose permission mode nobody can name.
  const autoReview = externalAutoReviewRequested(record)
  return {
    home,
    command: process.execPath,
    args: [options.nativeBridgePath],
    promptImageSupport: route.imageInput === true,
    env: {
      ...systemEnvironment(),
      ELECTRON_RUN_AS_NODE: '1',
      OPL_NATIVE_HARNESS: record.harnessRef,
      OPL_NATIVE_COMMAND: command,
      OPL_NATIVE_MODEL: route.model,
      OPL_NATIVE_PERMISSION: record.sandbox,
      OPL_NATIVE_BASE_URL: base,
      OPL_NATIVE_API_KEY: key,
      OPL_NATIVE_IMAGE_INPUT: route.imageInput === true ? '1' : '0',
      ...(gitBash ? { OPL_NATIVE_GIT_BASH: gitBash } : {}),
      // Codex has no upstream Git Bash interface, so the opt-in is carried explicitly and the
      // bridge verifies the real shell instead of assuming the request took effect.
      ...((record.harnessRef === 'codex' && options.codexRuntime) || codexGitBashOptIn()
        ? { OPL_NATIVE_CODEX_GIT_BASH: '1' }
        : {}),
      // Only an explicit Auto record sets this. The bridge owns the per-Harness evidence
      // that the installed CLI really reports its official auto reviewer, and refuses the
      // session when it cannot. It is never derived from the sandbox profile.
      ...(autoReview ? { OPL_NATIVE_AUTO_REVIEW: '1' } : {}),
      ...environment(home, base, key),
    },
  }
}
