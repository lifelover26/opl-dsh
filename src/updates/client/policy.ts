/** Legacy status fixtures omit policy; the Host uses these same initial preferences. */
import type { OplUpdatePolicy, OplUpdateStatus } from '../contracts.ts'

export const DEFAULT_UPDATE_POLICY: Readonly<OplUpdatePolicy> = {
  mode: 'notify',
  idleMinutes: 5,
  countdownSeconds: 30,
}

/** @param status - Accepted Host status. @returns Its policy or the initial preferences. */
export function updatePolicy(status: OplUpdateStatus | null): Readonly<OplUpdatePolicy> {
  return status?.policy ?? DEFAULT_UPDATE_POLICY
}

/** @param policy - Requested preferences. @returns Whether all editable values are supported. */
export function validUpdatePolicy(policy: OplUpdatePolicy): boolean {
  return (
    (policy.mode === 'notify' || policy.mode === 'on-launch' || policy.mode === 'idle') &&
    Number.isInteger(policy.idleMinutes) &&
    policy.idleMinutes >= 1 &&
    policy.idleMinutes <= 120 &&
    Number.isInteger(policy.countdownSeconds) &&
    policy.countdownSeconds >= 15 &&
    policy.countdownSeconds <= 300
  )
}
