import type { ModelRef, ModelDefinition } from '../../contracts/catalog.ts'

export interface OfmModelReadiness {
  available: boolean
  reason?: string
  unavailableKind?: ModelDefinition['unavailableKind']
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * A cached roster entry is not a usable model. OFM's local lane must be on,
 * its listener must be running, and the model must remain in the live catalog
 * before an automatic execution combination can be enabled.
 */
export function ofmModelReadiness(
  summary: unknown,
  ref: ModelRef,
  externalHarness = false,
): OfmModelReadiness {
  const root = record(summary)
  const settings = record(root.settings)
  if (settings.enabled === false)
    return {
      available: false,
      reason: 'OFM 模型服务已停用，对应模型尚未启用',
      unavailableKind: 'disabled',
    }

  const catalog = Array.isArray(root.catalog) ? root.catalog : undefined
  if (!catalog)
    return {
      available: false,
      reason: 'OFM 当前目录读取失败，尚不能确认模型状态',
      unavailableKind: 'unconfirmed',
    }
  const entry = catalog.find((item) => record(item).id === ref.model)
  if (entry === undefined)
    return {
      available: false,
      reason: 'OFM 当前目录已移除此模型，保留原组合配置',
      unavailableKind: 'catalog-missing',
    }
  if (record(entry).route === null)
    return {
      available: false,
      reason: 'OFM 未启用此模型，对应组合保持停用',
      unavailableKind: 'disabled',
    }

  if (externalHarness) {
    const membership = record(root.membership)
    const routes = Object.values(membership).filter(Array.isArray)
    if (routes.length > 0 && !routes.some((models) => models.includes(ref.model)))
      return { available: false, reason: 'OFM 当前可用目录未包含此模型' }
  }

  const forward = record(settings.forward)
  if (externalHarness && forward.enabled !== true)
    return {
      available: false,
      reason: 'OFM 本地转发未启用，对应模型尚未就绪',
      unavailableKind: 'disabled',
    }
  if (externalHarness && forward.running !== true)
    return { available: false, reason: 'OFM 本地转发尚未运行' }

  return { available: true }
}
