/** First-run account choice; authentication stays in its provider service. */
import { Config as GatewayConfig } from '../gateway/host/config.ts'
import { Config as AutoReviewConfig } from '../auto-review/host/settings.ts'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { LoginChoice } from '../setup/contracts.ts'
import { executionLimitsSchema, type ExecutionLimits } from '../execution/contracts/limits.ts'
export { executionLimitsSchema } from '../execution/contracts/limits.ts'
export type { LoginChoice } from '../setup/contracts.ts'
export interface Config {
  /** Whether the activity pill counts retained conversation steps or every historical step. */
  conversationStats: Volatile<'current' | 'history'>
  /** Execution deadlines in milliseconds, excluding explicitly surfaced human waits. */
  executionLimits: ExecutionLimits
  /** Last built-in permission preset selected by the user for future native Sessions. */
  lastPermissionPreset: Volatile<'read-only' | 'workspace-write' | 'danger-full-access'>
  toolAutoReview: Volatile<import('../auto-review/host/settings.ts').Config>
  cooperation: Volatile<{ autoReview: boolean; maxRevisions: number; externalCodex: boolean }>
  gatewayGroups: Volatile<Record<string, boolean>>
  gatewayCatalogHashes: Volatile<Record<string, string>>
  gateway: Volatile<import('../gateway/host/config.ts').Config>
  loginChoice: Volatile<LoginChoice>
  setupCompleted: Volatile<boolean>
  wakeTransport: Volatile<'unconnected' | 'codex-queue'>
  wakeExecutable: Volatile<string>
  wakeExecution: Volatile<'native' | 'wsl'>
  wakeDistro: Volatile<string>
}
export const Config = z.object({
  conversationStats: z.union(['current', 'history']).default('current').volatile(),
  executionLimits: executionLimitsSchema,
  lastPermissionPreset: z
    .union(['read-only', 'workspace-write', 'danger-full-access'])
    .default('workspace-write')
    .volatile(),
  toolAutoReview: AutoReviewConfig.default({}).volatile(),
  cooperation: z
    .object({
      autoReview: z.boolean().default(true),
      maxRevisions: z.number().step(1).min(0).max(5).default(2),
      externalCodex: z.boolean().default(true),
    })
    .default({})
    .volatile(),
  gatewayGroups: z.dict(z.boolean()).default({}).volatile(),
  gatewayCatalogHashes: z.dict(z.string()).default({}).volatile(),
  gateway: GatewayConfig.default({}).volatile(),
  wakeTransport: z.union(['unconnected', 'codex-queue']).default('unconnected').volatile(),
  wakeExecutable: z.string().default('').volatile(),
  wakeExecution: z.union(['native', 'wsl']).default('native').volatile(),
  wakeDistro: z.string().default('').volatile(),
  setupCompleted: z.boolean().default(false).volatile(),
  loginChoice: z
    .union(['undecided', 'gateway', 'official', 'later'])
    .default('undecided')
    .volatile(),
})
