/**
 * Read-only projection of the official MiniMax Code OAuth metadata.
 *
 * The official CLI owns the account. This module only locates its namespace and reads the
 * status whitelist from `auth-state.json`; it never opens `auth.json`, never reads a token,
 * and never copies the `authorization` block (which contains a user code and URL).
 *
 * Namespace layout verified against the installed 0.6.3 sources:
 *   <dataDir>/auth/<buildEnv>/<region>/mcode-public/auth-state.json
 * where the CLI maps the public `--region global` value to its internal `en` region and a
 * production package uses the embedded `prod` build environment. `MINIMAX_DATA_DIR` wins
 * over `MAVIS_DATA_DIR`; otherwise the CLI uses `~/.minimax`, or `~/.minimax-<profile>`
 * when its launch prefix carries `--profile <name>`.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { MiniMaxAccountStatus } from '../contracts/minimax-account.ts'

export type MiniMaxAccountRegion = MiniMaxAccountStatus['region']
export type MiniMaxAccountLoginState = MiniMaxAccountStatus['loginState']

/** The namespace segment the official CLI always uses for its public OAuth client. */
export const MINIMAX_ACCOUNT_NAMESPACE = 'mcode-public'
/** Production packages embed `prod`; `--env` only exists in internal builds. */
export const MINIMAX_ACCOUNT_BUILD_ENV = 'prod'

/** Official `auth-state.json` status values accepted by schema versions 1 and 2. */
export const MINIMAX_ACCOUNT_STATUS_VALUES = [
  'anonymous',
  'authorizing',
  'authenticated',
  'refreshing',
  'scope_upgrade_required',
  'logging_out',
  'logout_pending',
  'expired',
  'error',
] as const
export type MiniMaxOfficialAccountStatus = (typeof MINIMAX_ACCOUNT_STATUS_VALUES)[number]

const OFFICIAL_STATUSES = new Set<string>(MINIMAX_ACCOUNT_STATUS_VALUES)

export interface MiniMaxAccountStateLocation {
  dataDir: string
  buildEnv: string
  /** The official CLI's internal region: `global` is stored as `en`. */
  internalRegion: 'cn' | 'en'
  statePath: string
}

/** What a bounded read of `auth-state.json` established. */
export type MiniMaxAccountStateRead =
  | { kind: 'missing' }
  | { kind: 'unknown'; reason: 'unreadable' | 'invalid' | 'namespace' }
  | {
      kind: 'present'
      status: MiniMaxOfficialAccountStatus
      /** Present for authenticated/expired states; used only to document CLI refresh. */
      expiresAtMs?: number
    }

export interface MiniMaxAccountStateOptions {
  env?: NodeJS.ProcessEnv
  /** Arguments before the official subcommand; `--profile` selects a data-dir suffix. */
  prefix?: readonly string[]
  /** Explicit namespace for controlled callers; otherwise derived from `prefix` or unknown. */
  buildEnv?: string
}

/**
 * Resolve the data directory exactly as the official CLI does for an OPL-launched process.
 *
 * The CLI reads `MINIMAX_DATA_DIR` first, then `MAVIS_DATA_DIR`, then `~/.minimax` (or the
 * `--profile` suffixed directory). It never scans other build environments or regions: a
 * status query is always scoped to the requested region's own namespace.
 */
export function minimaxAccountDataDir(
  env: NodeJS.ProcessEnv = process.env,
  prefix: readonly string[] = [],
): string {
  const override = env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim()
  if (override) return resolve(override)
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir()
  const profile = optionValue(prefix, '--profile')
  return resolve(home, profile ? `.minimax-${profile}` : '.minimax')
}

/** Read one `--name value` / `--name=value` option from the official launch prefix. */
function optionValue(prefix: readonly string[], name: string): string | undefined {
  for (let index = 0; index < prefix.length; index += 1) {
    const argument = prefix[index]
    if (argument === name) {
      const value = prefix[index + 1]?.trim()
      return value || undefined
    }
    if (argument?.startsWith(`${name}=`)) {
      const value = argument.slice(name.length + 1).trim()
      return value || undefined
    }
  }
  return undefined
}

/**
 * Derive the build environment from the configured launch prefix.
 *
 * A production package embeds `prod` and rejects `--env`; only an internal package honors
 * the flag. The command and prefix do not prove which package is selected, so a prefix that
 * carries `--env` leaves the namespace unknown instead of asserting the wrong directory
 * (which would show a false signed-out). Without `--env`, production is the only namespace
 * OPL launches.
 */
export function minimaxAccountBuildEnv(prefix: readonly string[] = []): string | undefined {
  for (const argument of prefix) {
    if (argument === '--env' || argument.startsWith('--env=')) return undefined
  }
  return MINIMAX_ACCOUNT_BUILD_ENV
}

/** Build the official namespace path for one public region without probing other regions. */
export function minimaxAccountStateLocation(
  region: MiniMaxAccountRegion,
  options: Pick<MiniMaxAccountStateOptions, 'env' | 'prefix' | 'buildEnv'> = {},
): MiniMaxAccountStateLocation {
  const dataDir = minimaxAccountDataDir(options.env, options.prefix)
  const buildEnv = options.buildEnv ?? MINIMAX_ACCOUNT_BUILD_ENV
  const internalRegion = region === 'global' ? 'en' : 'cn'
  return {
    dataDir,
    buildEnv,
    internalRegion,
    statePath: join(
      dataDir,
      'auth',
      buildEnv,
      internalRegion,
      MINIMAX_ACCOUNT_NAMESPACE,
      'auth-state.json',
    ),
  }
}

/**
 * Read only the status whitelist. A missing file means the CLI has no stored account;
 * unreadable, malformed, unsupported, or namespace-mismatched metadata means we cannot
 * claim either state.
 */
export async function readMiniMaxAccountState(
  location: MiniMaxAccountStateLocation,
): Promise<MiniMaxAccountStateRead> {
  let text: string
  try {
    text = await readFile(location.statePath, 'utf8')
  } catch (error) {
    return isMissingFile(error) ? { kind: 'missing' } : { kind: 'unknown', reason: 'unreadable' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'unknown', reason: 'invalid' }
  }
  const metadata = metadataFrom(value, location)
  return metadata ?? { kind: 'unknown', reason: 'invalid' }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Validate the fields that decide whether this metadata belongs to the requested namespace.
 * The `authorization` block is deliberately never inspected or returned: it contains a
 * user code and verification URL, and none of it is needed to describe login state.
 */
function metadataFrom(
  value: unknown,
  location: MiniMaxAccountStateLocation,
): Extract<MiniMaxAccountStateRead, { kind: 'present' }> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const state = value as Record<string, unknown>
  if (state.schemaVersion !== 1 && state.schemaVersion !== 2) return undefined
  if (typeof state.status !== 'string' || !OFFICIAL_STATUSES.has(state.status)) return undefined
  if (state.storeKind !== 'file' && state.storeKind !== 'os-keyring') return undefined
  if (state.schemaVersion === 2 && state.storeKind !== 'file') return undefined
  if (state.clientId !== MINIMAX_ACCOUNT_NAMESPACE) return undefined
  if (state.audience !== 'agent-backend') return undefined
  if (!Array.isArray(state.scopes) || !state.scopes.every((scope) => typeof scope === 'string'))
    return undefined
  if (state.buildEnv !== location.buildEnv || state.region !== location.internalRegion)
    return undefined
  if (
    state.expiresAtMs !== undefined &&
    (typeof state.expiresAtMs !== 'number' || !Number.isFinite(state.expiresAtMs))
  )
    return undefined
  if (
    typeof state.generation !== 'number' ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 0
  )
    return undefined
  return {
    kind: 'present',
    status: state.status as MiniMaxOfficialAccountStatus,
    ...(state.expiresAtMs === undefined ? {} : { expiresAtMs: state.expiresAtMs }),
  }
}

/**
 * Map official metadata to the bounded page state.
 *
 * `authenticated`, `refreshing`, `expired`, and `scope_upgrade_required` indicate a stored
 * login; the CLI refreshes expired access tokens on demand. `logging_out` and
 * `logout_pending` report an unfinished sign-out separately. `anonymous` and `authorizing`
 * mean no usable account is stored. `error` and unreadable metadata cannot support either
 * account claim.
 *
 * This is local account presence, not online validity: it never proves that the refresh
 * token is accepted, that the account is not revoked, or that quota remains.
 */
export function miniMaxAccountLoginState(state: MiniMaxAccountStateRead): MiniMaxAccountLoginState {
  if (state.kind === 'missing') return 'signed-out'
  if (state.kind === 'unknown') return 'unknown'
  switch (state.status) {
    case 'anonymous':
    case 'authorizing':
      return 'signed-out'
    case 'authenticated':
    case 'refreshing':
    case 'expired':
    case 'scope_upgrade_required':
      return 'signed-in'
    case 'logging_out':
    case 'logout_pending':
      return 'signing-out'
    case 'error':
      return 'unknown'
  }
  // The source enumerates the same statuses; keep a safe fallback for forward schemas.
  return 'unknown'
}

/** Convenience read used by the account service; never crosses into another region. */
export async function readMiniMaxAccountLoginState(
  region: MiniMaxAccountRegion,
  options: MiniMaxAccountStateOptions = {},
): Promise<{
  location?: MiniMaxAccountStateLocation
  state: MiniMaxAccountStateRead
  loginState: MiniMaxAccountLoginState
}> {
  const buildEnv = options.buildEnv ?? minimaxAccountBuildEnv(options.prefix ?? [])
  if (!buildEnv) return { state: { kind: 'unknown', reason: 'namespace' }, loginState: 'unknown' }
  const location = minimaxAccountStateLocation(region, {
    ...(options.env ? { env: options.env } : {}),
    ...(options.prefix ? { prefix: options.prefix } : {}),
    buildEnv,
  })
  const state = await readMiniMaxAccountState(location)
  return { location, state, loginState: miniMaxAccountLoginState(state) }
}
