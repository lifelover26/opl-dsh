/**
 * Adopt the OPL account's gateway key into this Harness home.
 *
 * Requests can read OPL's binding directly, so nothing here is needed to make
 * a turn work. Adoption exists for the configuration surfaces: a route whose
 * credential reference resolves is the one the Models page draws as ready and
 * the first-run posture accepts, and a user who signed in to OPL should not be
 * asked for a key because two products keep separate stores.
 *
 * The write is bounded on purpose. It only ever fills an unset reference, it
 * refreshes only a value this module adopted earlier, and it records the
 * adopted key's fingerprint — never the key — so a key the operator typed on
 * the Models page is never overwritten.
 */

import type { GatewayGroupId } from '../contracts/groups.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { importOplGatewayKey } from './opl-credentials.ts'

/** File recording which key value this plugin adopted, without the secret. */
export const ADOPTION_RECORD_FILENAME = 'opl-gateway-key-adoption.json'

/**
 * Fingerprint of one key value.
 * @param value - key material to fingerprint; the value itself is never recorded.
 * @returns the SHA-256 hex digest stored in the adoption record.
 */
export function keyFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Read the fingerprint of the key this plugin adopted earlier.
 * @param home - Harness home directory.
 * @param channel - independently owned key group.
 * @returns the recorded fingerprint, or undefined.
 */
export function readAdoptedFingerprint(
  home: string,
  channel: GatewayGroupId = 'deepseek',
): string | undefined {
  try {
    const value: unknown = JSON.parse(
      readFileSync(
        join(
          home,
          channel === 'deepseek'
            ? ADOPTION_RECORD_FILENAME
            : `opl-gateway-${channel}-key-adoption.json`,
        ),
        'utf8',
      ),
    )
    if (typeof value !== 'object' || value === null) return undefined
    const fingerprint = (value as { fingerprint?: unknown }).fingerprint
    return typeof fingerprint === 'string' && /^[a-f0-9]{64}$/u.test(fingerprint)
      ? fingerprint
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Record the fingerprint of the key this plugin adopted.
 * @param home - Harness home directory.
 * @param channel - independently owned key group.
 * @param fingerprint - fingerprint to record.
 */
export function writeAdoptedFingerprint(
  home: string,
  fingerprint: string,
  channel: GatewayGroupId = 'deepseek',
): void {
  const path = join(
    home,
    channel === 'deepseek' ? ADOPTION_RECORD_FILENAME : `opl-gateway-${channel}-key-adoption.json`,
  )
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, fingerprint }, undefined, 2)}\n`, {
    mode: 0o600,
  })
}

/** Outcome of one adoption attempt, for diagnostics and tests. */
export type AdoptionOutcome =
  'no-account' | 'kept-operator-key' | 'adopted' | 'refreshed' | 'unchanged' | 'unavailable'

/**
 * Bring the credentials seam in line with the OPL account binding.
 * @param options - credentials seam, Harness home, reference, and state overrides.
 * @returns what the attempt did, so a caller can log or assert on it.
 */
export async function adoptOplGatewayKey(options: {
  credentials: CredentialProvider
  home: string
  ref: CredentialRef
  stateDirectory?: string
}): Promise<AdoptionOutcome> {
  const imported = importOplGatewayKey(
    options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory },
  )
  if (imported === undefined) return 'no-account'
  const fingerprint = keyFingerprint(imported.key)
  const recorded = readAdoptedFingerprint(options.home)
  let stored
  try {
    stored = await options.credentials.resolve(options.ref)
  } catch {
    return 'unavailable'
  }
  const storedFingerprint = stored === undefined ? undefined : keyFingerprint(stored.value)
  if (storedFingerprint === fingerprint) {
    // Already the account's key, whoever put it there.
    if (recorded !== fingerprint) writeAdoptedFingerprint(options.home, fingerprint)
    return 'unchanged'
  }
  if (storedFingerprint !== undefined && storedFingerprint !== recorded) {
    // The operator typed a different key on the Models page; their choice wins.
    return 'kept-operator-key'
  }
  try {
    await options.credentials.set(options.ref, imported.key)
  } catch {
    // A read-only source shadowing the reference keeps serving requests
    // through the live import, so a rejected write is not a failure to reach
    // the model.
    return 'unavailable'
  }
  writeAdoptedFingerprint(options.home, fingerprint)
  return storedFingerprint === undefined ? 'adopted' : 'refreshed'
}
