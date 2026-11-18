/** First-run account choice; authentication stays in its provider service. */
import { Config as GatewayConfig } from '../gateway/host/config.ts'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { LoginChoice } from '../setup/contracts.ts'
export type { LoginChoice } from '../setup/contracts.ts'
export interface Config {
  /** Exact Loader disabled values saved by the explicit Windows Git Bash selection. */
  nativeShellReceipt: Volatile<string>
  /** Check stable OPL releases automatically according to the selected update policy. */
  updateAutomatic: Volatile<boolean>
  updatePolicy: Volatile<import('../updates/contracts.ts').OplUpdatePolicy>
  /** Distinguish a current explicit policy from the legacy reminder default. */
  updatePolicyChosen: Volatile<boolean>
  /** Whether the activity pill counts retained conversation steps or every historical step. */
  conversationStats: Volatile<'current' | 'history'>
  /** Opt in to the OPL activity-pill count projection; official counts remain the default. */
  enhancedConversationStats: Volatile<boolean>
  /** Keep the desktop window and taskbar title fixed instead of following the active Session. */
  fixedWindowTitle: Volatile<boolean>
  gatewayGroups: Volatile<Record<string, boolean>>
  gatewayCatalogHashes: Volatile<Record<string, string>>
  gateway: Volatile<import('../gateway/host/config.ts').Config>
  loginChoice: Volatile<LoginChoice>
  setupCompleted: Volatile<boolean>
}
export const Config = z.object({
  nativeShellReceipt: z.string().default('').volatile(),
  updateAutomatic: z.boolean().default(true).volatile(),
  updatePolicy: z
    .object({
      mode: z.union(['notify', 'on-launch', 'idle']).default('on-launch'),
      idleMinutes: z.number().step(1).min(1).max(120).default(5),
      countdownSeconds: z.number().step(1).min(15).max(300).default(30),
    })
    .default({})
    .volatile(),
  updatePolicyChosen: z.boolean().default(false).volatile(),
  conversationStats: z.union(['current', 'history']).default('current').volatile(),
  enhancedConversationStats: z.boolean().default(false).volatile(),
  fixedWindowTitle: z.boolean().default(true).volatile(),
  gatewayGroups: z.dict(z.boolean()).default({}).volatile(),
  gatewayCatalogHashes: z.dict(z.string()).default({}).volatile(),
  gateway: GatewayConfig.default({}).volatile(),
  setupCompleted: z.boolean().default(false).volatile(),
  loginChoice: z
    .union(['undecided', 'gateway', 'official', 'later'])
    .default('undecided')
    .volatile(),
})
