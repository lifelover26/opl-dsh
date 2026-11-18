/** Exact EAC route and Qwen Code ACP identity; no provider aliases are inferred. */
import type { ModelRef } from '../../../contracts/catalog.ts'
export const QWEN_CODE_HARNESS = 'qwen-code'
export const QWEN_MODEL = 'amd/Qwen3.8-27B'
/** Qwen Code qualifies custom OpenAI model identities in its ACP advertisement. */
export const QWEN_ACP_MODEL = `${QWEN_MODEL}(openai)`
/** Official npm release exercised by this adapter. */
export const QWEN_CODE_VERSION = '0.27.3'
export function isQwenModel(ref: ModelRef): boolean {
  return ref.provider === 'our-free-model' && ref.model === QWEN_MODEL
}
