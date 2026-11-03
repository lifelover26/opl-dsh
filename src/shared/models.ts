/** Models are read-only projections of DSH's model registry. */
export interface ModelRef {
  provider: string
  model: string
}
export interface ModelDefinition {
  ref: ModelRef
  name: string
  source: string
  available: boolean
  reason?: string
  /** Current source state; omitted when only the execution route is unavailable. */
  unavailableKind?: 'catalog-missing' | 'disabled' | 'unconfirmed'
}
export const modelRefKey = (ref: ModelRef) => JSON.stringify([ref.provider, ref.model])

/**
 * Models that were advertised by an older provider catalog but are no longer
 * part of the OPL product surface. Keep this decision in one place so the
 * model list, automatic combinations and persisted legacy combinations agree.
 */
export function isRetiredModel(ref: ModelRef): boolean {
  const id = ref.model.includes('::') ? ref.model.slice(ref.model.lastIndexOf('::') + 2) : ref.model
  const provider = ref.provider.toLowerCase()
  if (
    id === 'deepseek-v4-pro' &&
    (provider.includes('deepseek') || provider.includes('opl-gateway'))
  )
    return true
  if (
    (id === 'gpt-5' || id === 'gpt-5-mini') &&
    (provider.includes('opl-gateway') || provider.includes('codex'))
  )
    return true
  return false
}

/** Stable product names for IDs whose upstream display text changed. */
export function displayModelName(ref: ModelRef, name?: string): string {
  const id = ref.model.includes('::') ? ref.model.slice(ref.model.lastIndexOf('::') + 2) : ref.model
  if (ref.provider === 'our-free-model') {
    if (id === 'opencode/nemotron-3.5-lightning-free') return 'EAC Nemotron 3.5 Lightning Free'
    if (id === 'opencode/nemotron-3.5-super-vl-free') return 'EAC Nemotron 3.5 Super VL Free'
    if (id === 'opencode/flint-40b-free') return 'EAC Flint 40B Free'
    if (id === 'thinkingmachines/inkling:free') return 'Kilo Inkling'
    if (id === 'google/gemma-4-31b-it:free') return 'Kilo Gemma 4 31B'
    if (id === 'minimaxai/minimax-m3.1-flash') return 'EAC MiniMax M3.1 Flash'
    if (id === 'stepfun-ai/step-5-preview') return 'EAC Step 5 Preview'
    if (id === 'mistralai/mistral-large-4-1t-a52b') return 'EAC Mistral Large 4'
    if (id === 'inclusionai/ling-3.1-flash-1019-free') return 'Kilo Ling 3.1 Flash 1019'
    if (id === 'minimax-m3.1-flash-free') return 'MiniMax M3.1 Flash Free'
    if (id === 'minimax/minimax-m3.1-flash:free') return 'Kilo MiniMax M3.1 Flash'
    if (id === 'nvidia/nemotron-3-super-120b-a12b:free') return 'Kilo Nemotron 3 Super'
    if (id === 'flint-40b-free') return 'Flint 40B Free'
    if (id === 'recursive/flint-v1.0:free') return 'Flint v1.0 Free'
  }
  if (id === 'deepseek-v4.1-flash') return 'DeepSeek-V4.1-Flash（固定版本）'
  if (id === 'deepseek-flash')
    return ref.model.startsWith('codex::')
      ? 'DeepSeek-V4.1-Flash · OpenAI 协议'
      : 'DeepSeek-V4.1-Flash'
  if (ref.provider === 'opl-gateway' && ref.model.startsWith('gemini::')) {
    if (id === 'gemini-4-argon') return 'Gemini 4 Argon'
    if (id === 'gemini-3.8-flash') return 'Gemini 3.8 Flash'
    if (id === 'gemini-3.1-pro') return 'Gemini 3.1 Pro'
  }
  // MiniMax models belong to the official CLI account, not to a Gateway channel.
  // The name stays a bare model name: the Harness is appended once by the model
  // menu, and the thinking setting lives in the reasoning menu, so neither may be
  // baked into this label.
  if (ref.provider === 'minimax-official') {
    if (id === 'MiniMax-M3.1-Flash') return 'MiniMax-M3.1-Flash'
    if (id === 'MiniMax-M3') return 'MiniMax-M3'
  }
  const route = ref.provider === 'opl-gateway' ? ref.model.split('::')[0] : ''
  const suffix = route === 'aws' ? 'AWS' : route === 'kiro' ? 'Kiro' : ''
  const label = id === 'claude-opus-5-5' ? 'Claude Opus 5.5' : name?.trim() || id
  return suffix && !label.endsWith(' · ' + suffix) ? label + ' · ' + suffix : label
}

export function displayModelSource(ref: ModelRef, source?: string): string {
  if (ref.provider === 'opl-gateway') return 'OPL Gateway'
  if (ref.provider === 'minimax-official') return 'MiniMax 官方账号（mcode）'
  if (ref.provider === 'our-free-model')
    return source === 'OpenCode 官方免费通道' ? source : 'Our Free Model'
  if (ref.provider === 'our-free-model-region') return 'Our Free Model · region-limited'
  if (ref.provider === 'deepseek-account' || ref.provider === 'deepseek-official')
    return 'DeepSeek 官方'
  return source?.trim() || ref.provider
}

/** Compact source status; the full reason remains available on hover. */
export function unavailableModelLabel(kind: ModelDefinition['unavailableKind']): string {
  if (kind === 'catalog-missing') return '目录已移除'
  if (kind === 'disabled') return '未启用'
  if (kind === 'unconfirmed') return '状态未确认'
  return '不可用'
}

/** User-facing choices: credential-ready models, with one preferred route per Gateway model.
 * Preserve the full catalog and saved refs for diagnostics and existing combinations.
 */
export function selectableModels(models: readonly ModelDefinition[]): ModelDefinition[] {
  const choices = new Map<string, ModelDefinition>()
  for (const model of models) {
    if (!model.available || isRetiredModel(model.ref)) continue
    const key =
      model.ref.provider === 'opl-gateway'
        ? gatewayChoiceKey(model.ref.model)
        : modelRefKey(model.ref)
    const previous = choices.get(key)
    if (!previous) choices.set(key, model)
  }
  return [...choices.values()]
}

/** Paid channels remain distinct even when they serve the same model. */
export function gatewayChoiceKey(model: string): string {
  return model
}
