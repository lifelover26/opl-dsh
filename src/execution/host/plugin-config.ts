import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { executionLimitsSchema, type ExecutionLimits } from '../contracts/limits.ts'
import { Config as AutoReviewConfig } from '../../auto-review/host/settings.ts'
export interface Config {
  executionLimits: ExecutionLimits
  lastPermissionPreset: Volatile<'read-only' | 'workspace-write' | 'danger-full-access'>
  toolAutoReview: Volatile<import('../../auto-review/host/settings.ts').Config>
}
export const Config = z.object({
  executionLimits: executionLimitsSchema,
  lastPermissionPreset: z
    .union(['read-only', 'workspace-write', 'danger-full-access'])
    .default('workspace-write')
    .volatile(),
  toolAutoReview: AutoReviewConfig.default({}).volatile(),
})
