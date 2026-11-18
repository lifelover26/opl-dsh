import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { executionLimitsSchema, type ExecutionLimits } from '../contracts/limits.ts'
import { Config as AutoReviewConfig } from '../../auto-review/host/settings.ts'
export interface Config {
  executionLimits: Volatile<ExecutionLimits>
  /** Persist explicit native permission choices as the official future-session default. */
  rememberPermissionPreset: Volatile<boolean>
  toolAutoReview: Volatile<import('../../auto-review/host/settings.ts').Config>
}
export const Config = z.object({
  executionLimits: executionLimitsSchema.volatile(),
  rememberPermissionPreset: z.boolean().default(false).volatile(),
  toolAutoReview: AutoReviewConfig.default({}).volatile(),
})
