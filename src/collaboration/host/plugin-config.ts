import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
export interface Config {
  cooperation: Volatile<{ autoReview: boolean; maxRevisions: number; externalCodex: boolean }>
  roleExecutions: Volatile<Record<string, string>>
  wakeTransport: Volatile<'unconnected' | 'codex-queue'>
  wakeExecutable: Volatile<string>
  wakeExecution: Volatile<'native' | 'wsl'>
  wakeDistro: Volatile<string>
}
export const Config = z.object({
  cooperation: z
    .object({
      autoReview: z.boolean().default(true),
      maxRevisions: z.number().step(1).min(0).max(5).default(2),
      externalCodex: z.boolean().default(true),
    })
    .default({})
    .volatile(),
  roleExecutions: z.dict(z.string().min(1)).default({}).volatile(),
  wakeTransport: z.union(['unconnected', 'codex-queue']).default('unconnected').volatile(),
  wakeExecutable: z.string().default('').volatile(),
  wakeExecution: z.union(['native', 'wsl']).default('native').volatile(),
  wakeDistro: z.string().default('').volatile(),
})
