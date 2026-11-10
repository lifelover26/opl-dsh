import type { ModelRef } from './catalog.ts'

/**
 * Vendor-owned model/harness pairings.
 *
 * This is product metadata shared by the Host resolver and the Client catalog UI.
 * A generic agent runner (OpenCode, Kilo, Pi) deliberately has an empty model list:
 * it can execute a model when the user explicitly pairs it, but it does not own an
 * official model catalog of its own.
 */
export interface OfficialHarness {
  readonly id: string
  readonly officialModels: readonly ModelRef[]
}

export const OFFICIAL_HARNESSES: readonly OfficialHarness[] = [
  {
    id: 'dsh',
    officialModels: [
      { provider: 'deepseek', model: '*' },
      { provider: 'deepseek-official', model: '*' },
      { provider: 'deepseek-account', model: '*' },
      { provider: 'opl-gateway', model: 'deepseek-flash' },
    ],
  },
  {
    id: 'grok-build',
    officialModels: [{ provider: 'opl-gateway', model: 'grok::grok-4.7' }],
  },
  {
    id: 'codex',
    officialModels: [
      { provider: 'opl-gateway', model: 'codex::gpt-*' },
      { provider: 'our-free-model', model: 'openai/gpt-oss-20b' },
    ],
  },
  {
    id: 'claude',
    officialModels: [
      { provider: 'opl-gateway', model: 'aws::claude-*' },
      { provider: 'opl-gateway', model: 'kiro::claude-*' },
    ],
  },
  {
    id: 'antigravity',
    officialModels: [
      { provider: 'opl-gateway', model: 'gemini::gemini-3.8-flash' },
      { provider: 'opl-gateway', model: 'gemini::gemini-4-argon' },
    ],
  },
  {
    id: 'minimax-code',
    officialModels: [
      { provider: 'minimax-official', model: 'MiniMax-M3.1-Flash' },
      { provider: 'minimax-official', model: 'MiniMax-M3' },
    ],
  },
  {
    id: 'zcode',
    officialModels: [],
  },
  {
    id: 'kimi-code',
    officialModels: [
      { provider: 'our-free-model', model: 'moonshotai/kimi-k2.6' },
      { provider: 'our-free-model', model: 'moonshotai/kimi-k3' },
    ],
  },
  {
    id: 'mimo-code',
    officialModels: [{ provider: 'our-free-model', model: 'mimo-v2.6-flash-free' }],
  },
  {
    id: 'pool',
    officialModels: [
      { provider: 'our-free-model', model: 'poolside/laguna-s-2.1:free' },
      { provider: 'our-free-model', model: 'poolside/laguna-xs-2.1:free' },
    ],
  },
  {
    id: 'step-code',
    officialModels: [
      { provider: 'our-free-model', model: 'step-5-preview-free' },
      { provider: 'our-free-model', model: 'stepfun/step-5-preview-free' },
      { provider: 'our-free-model', model: 'stepfun-ai/step-5-preview' },
    ],
  },
  {
    id: 'muse-code',
    officialModels: [
      { provider: 'our-free-model', model: 'muse-spark-1.2-contributor-free' },
      { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free' },
    ],
  },
  { id: 'opencode', officialModels: [] },
  { id: 'pi', officialModels: [] },
  {
    id: 'vibe',
    officialModels: [{ provider: 'our-free-model', model: 'mistralai/mistral-large-4-1t-a52b' }],
  },
  { id: 'kilo', officialModels: [] },
]

const matchesModel = (pattern: ModelRef, ref: ModelRef): boolean => {
  if (pattern.provider !== ref.provider) return false
  if (pattern.model === '*') return true
  if (pattern.model.endsWith('*')) return ref.model.startsWith(pattern.model.slice(0, -1))
  return pattern.model === ref.model
}

/** The vendor that officially pairs a model, if one exists. */
export function officialHarnessFor(ref: ModelRef): string | undefined {
  return OFFICIAL_HARNESSES.find((item) =>
    item.officialModels.some((model) => matchesModel(model, ref)),
  )?.id
}

/** Whether this exact model and harness pair is vendor-owned. */
export function isOfficialPairing(harnessRef: string, ref: ModelRef): boolean {
  return officialHarnessFor(ref) === harnessRef
}
