/** Check OFM's current directory before native request validation or vendor history changes. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ModelRef } from '../contracts/catalog.ts'
import { OFM_PROVIDERS } from './ofm-source/provider.ts'
import { ofmModelReadiness } from './ofm-source/readiness.ts'

/**
 * Reject an absent or unconfirmed exact model without inferring its reasoning support.
 * @param ctx - Host owning the live LLM registry.
 * @param ref - Exact provider and model selected for this request.
 * @param readOfm - Optional public OFM owner-state reader.
 * @param externalHarness - Whether this route requires OFM's external forwarder.
 */
export async function assertOfmModelAvailable(
  ctx: Context,
  ref: ModelRef,
  readOfm: (() => Promise<unknown>) | undefined,
  externalHarness: boolean,
): Promise<void> {
  if (!OFM_PROVIDERS.includes(ref.provider)) return
  if (readOfm) {
    let summary: unknown
    try {
      summary = await readOfm()
    } catch {
      throw new LlmError(
        'OFM 当前目录读取失败，尚不能确认模型状态；本轮未发送。',
        'MODEL_STATUS_UNCONFIRMED',
      )
    }
    const readiness = ofmModelReadiness(summary, ref, externalHarness)
    if (!readiness.available)
      throw new LlmError(
        readiness.unavailableKind === 'catalog-missing'
          ? 'OFM 当前目录未包含此模型，请在模型菜单重新选择；本轮未发送。'
          : `${readiness.reason ?? 'OFM 模型当前不可用'}；本轮未发送。`,
        readiness.unavailableKind === 'catalog-missing'
          ? 'MODEL_NOT_FOUND'
          : readiness.unavailableKind === 'unconfirmed'
            ? 'MODEL_STATUS_UNCONFIRMED'
            : 'MODEL_UNAVAILABLE',
      )
  }
  let listed: boolean
  try {
    listed = (await ctx.llm.listModels(ref.provider)).some((model) => model.id === ref.model)
  } catch {
    throw new LlmError(
      'OFM 模型目录尚未就绪，请刷新后重试；本轮未发送。',
      'MODEL_STATUS_UNCONFIRMED',
    )
  }
  if (!listed)
    throw new LlmError(
      'OFM 当前模型目录未提供此模型，请在模型菜单重新选择；本轮未发送。',
      'MODEL_NOT_FOUND',
    )
  if (!ctx.llm.listProviders().some((provider) => provider.id === ref.provider))
    throw new LlmError('OFM 模型渠道已卸载，请刷新后重试；本轮未发送。', 'MODEL_UNAVAILABLE')
}
