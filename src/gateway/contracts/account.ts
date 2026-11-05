import type { GatewayGroupId } from './groups.ts'
import type { GatewayCatalogStatus, GatewayModelDiagnostic } from './models.ts'
/**
 * Wire-safe account vocabulary for the OPL Gateway surface.
 *
 * This module is a public type subpath on purpose: every type that crosses the
 * Remote boundary must be importable by consumers without pulling this
 * package's Cordis Context augmentation into their compilation.
 *
 * @module @one-person-lab/dsh-llm-opl-gateway/types
 */

/**
 * What the account page should present.
 *
 * `connected` covers both sources: a session this process opened, and the
 * binding OPL already recorded on this machine. The page never asks for a
 * password to show facts it can already read.
 */
export type GatewayAccountPhase = 'signed-out' | 'connected' | 'unavailable'

/** The signed-in account as the page renders it. */
export interface GatewayAccountFacts {
  readonly availableGroups?: readonly { id: string; label: string; rateMultiplier?: number }[]
  readonly displayName: string | null
  readonly email: string | null
  readonly status: string
  readonly balanceAmount: number | null
  readonly balanceCurrency: string
  readonly todayTokens: number | null
  readonly totalTokens: number | null
  readonly todayCost: number | null
  readonly totalCost: number | null
  readonly usageCurrency: string
  /** Name of the inference key this route uses, when one is known. */
  readonly keyName: string | null
  /** When the facts were observed, for the freshness line. */
  readonly observedAt?: string | null
  /** Whether the observation is past its freshness window. */
  readonly stale?: boolean
}

export interface GatewayGroupStatus {
  readonly id: GatewayGroupId
  readonly name: string
  readonly enabled?: boolean
  readonly authorized?: boolean
  readonly rateMultiplier?: number
  readonly state: 'ready' | 'unauthorized' | 'unconfigured' | 'error'
  readonly error?: string
  readonly catalog?: GatewayCatalogStatus
}
/** One status answer, secret-free. */
export interface GatewayAccountStatus {
  readonly phase: GatewayAccountPhase
  readonly groups?: readonly GatewayGroupStatus[]
  /** Endpoint inference uses for this account. */
  readonly endpoint: string
  /** Whether the credential reference the adapter resolves currently resolves. */
  readonly keyReady: boolean
  /** Independent OpenAI-protocol key for OpenAI-routed models and search. */
  readonly codexKeyReady?: boolean
  /** Independent Grok-group key for the Grok Build harness. */
  readonly grokKeyReady?: boolean
  /** Last model group that returned output in this process. */
  readonly activeChannel?: GatewayGroupId | undefined
  /** Provisioning failure of the optional OpenAI-protocol model group. */
  readonly channelError?: string | undefined
  /** Provisioning failure of the optional Grok Build combination. */
  readonly harnessError?: string | undefined
  /** Unexpected failure outside an individual group's model-listing operation. */
  readonly modelSyncError?: GatewayModelDiagnostic
  /**
   * Where the account facts came from: this process's own session, or the
   * binding OPL recorded. Absent when neither has one.
   */
  readonly source?: 'session' | 'opl'
  readonly account?: GatewayAccountFacts
  /** Why the last operation failed, when one did. */
  readonly error?: { readonly code: string; readonly message: string }
}

/** What one sign-in attempt returns. */
export interface GatewaySignInResult {
  readonly status: GatewayAccountStatus
  /** Whether this attempt minted a new inference key rather than reusing one. */
  readonly createdKey: boolean
  /** Authentication succeeded but optional password storage failed. */
  readonly passwordSaveFailed?: boolean
}

/** Saved login metadata, without the password. */
export interface GatewayRememberedLogin {
  readonly supported: boolean
  readonly email?: string
}
