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
 * Models advertised by an older provider catalog but no longer part of the
 * OPL product surface. Keep this decision shared by projection and persistence.
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

/** Gateway Gemini models natively paired with the official Antigravity CLI (and OpenCode fallback). */
export const GATEWAY_ANTIGRAVITY_GEMINI_MODELS = [
  'gemini-4-carbon',
  'gemini-4-hydrogen',
  'gemini-4-argon',
  'gemini-3.8-flash',
] as const

/** Stable product names for IDs whose upstream display text changed. */
export function displayModelName(ref: ModelRef, name?: string): string {
  const id = ref.model.includes('::') ? ref.model.slice(ref.model.lastIndexOf('::') + 2) : ref.model
  if (ref.provider === 'our-free-model') {
    if (id === 'moonshotai/kimi-k3.1-pro') return 'EAC Kimi K3.1 Pro'
    if (id === 'amd/Qwen3.8-27B') return 'EAC Qwen3.8 27B（AMD）'
    if (id === 'amd/DeepSeek-V4.1-Flash') return 'EAC DeepSeek V4.1 Flash（AMD）'
    if (id === 'amd/DeepSeek-V4-Flash') return 'EAC DeepSeek V4 Flash（AMD）'
    if (id === 'amd/MiMo-V2.6-Flash') return 'EAC MiMo V2.6 Flash（AMD）'
    if (id === 'amd/GLM-5.3-Flash') return 'EAC GLM 5.3 Flash（AMD）'
    if (id === 'amd/MiniCPM-V-4.7-35B-A3B') return 'EAC MiniCPM-V 4.7 35B-A3B（AMD）'
    if (id === 'amd/MiniCPM5-2B') return 'EAC MiniCPM5 2B（AMD）'
    if (id === 'amd/Gemma-4-31B-IT') return 'EAC Gemma 4 31B IT（AMD）'
    if (id === 'amd/MiniCPM-V-4.7-1B') return 'EAC MiniCPM-V 4.7 1B（AMD）'
    if (id === 'longcat-2.5-free') return 'LongCat 2.5 Free'
    if (id === 'iceman-free') return 'Iceman Free'
    if (id === 'inkling-2-small-free') return 'Inkling 2 Small Free'
    if (id === 'opencode/nemotron-3.5-lightning-free') return 'EAC Nemotron 3.5 Lightning Free'
    if (id === 'opencode/nemotron-3.5-super-vl-free') return 'EAC Nemotron 3.5 Super VL Free'
    if (id === 'opencode/flint-40b-free') return 'EAC Flint 40B Free'
    if (id === 'thinkingmachines/inkling:free') return 'Kilo Inkling'
    if (id === 'google/gemma-4-31b-it:free') return 'Kilo Gemma 4 31B'
    if (id === 'minimaxai/minimax-m3.1-flash') return 'EAC MiniMax M3.1 Flash'
    if (id === 'stepfun-ai/step-5-preview') return 'EAC Step 5 Preview'
    if (id === 'mistralai/mistral-large-4-1t-a52b') return 'EAC Mistral Large 4'
    if (id === 'inclusionai/ling-3.1-flash-1019-free') return 'Kilo Ling 3.1 Flash 1019'
    if (id === 'inclusionai/ling-3.2-flash:free') return 'Kilo Ling 3.2 Flash'
    if (id === 'stealth/crouton-alpha') return 'Kilo Crouton Alpha'
    if (id === 'liquid/lfm-3-1.7b:free') return 'Kilo LFM3-1.7B'
    if (id === 'thinkingmachines/inkling-2-small:free') return 'Kilo Inkling 2 Small'
    if (id === 'baidu/ernie-5.5-flash-preview:free') return 'Kilo ERNIE-5.5-Flash-Preview'
    if (id === 'particle-ai/particle-1:free') return 'Kilo Particle-1'
    if (id === 'apodex/apodex-1.1-mini:free') return 'Kilo Apodex 1.1 Mini'
    if (id === 'minimax-m3.1-flash-free') return 'MiniMax M3.1 Flash Free'
    if (id === 'minimax/minimax-m3.1-flash:free') return 'Kilo MiniMax M3.1 Flash'
    if (id === 'nvidia/nemotron-3-super-120b-a12b:free') return 'Kilo Nemotron 3 Super'
    if (id === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')
      return 'Kilo Nemotron 3 Nano Omni'
    if (id === 'nvidia/nemotron-3.5-lightning:free') return 'Kilo Nemotron 3.5 Lightning'
    if (id === 'cohere/north-mini-code:free') return 'Kilo North Mini Code'
    if (id === 'nvidia/nemotron-3-ultra-550b-a55b:free') return 'Kilo Nemotron 3 Ultra'
    if (id === 'openrouter/free') return 'Kilo OpenRouter Free'
    if (id === 'hy4-flash-free') return 'Hy4 Flash Free'
    if (id === 'tidepool-alpha-free') return 'Tidepool Alpha Free'
    if (id === 'flint-40b-free') return 'Flint 40B Free'
    if (id === 'recursive/flint-v1.0:free') return 'Flint v1.0 Free'
  }
  if (id === 'deepseek-v4.1-flash') return 'DeepSeek-V4.1-Flash（固定版本）'
  if (id === 'deepseek-flash')
    return ref.model.startsWith('codex::')
      ? 'DeepSeek-V4.1-Flash · OpenAI 协议'
      : 'DeepSeek-V4.1-Flash'
  if (
    ref.provider === 'catalog' ||
    ref.provider === 'opl-gateway-gemini' ||
    (ref.provider === 'opl-gateway' && ref.model.startsWith('gemini::'))
  ) {
    if (id === 'gemini-4-carbon') return 'Gemini 4 Carbon'
    if (id === 'gemini-4-hydrogen') return 'Gemini 4 Hydrogen'
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
  const suffix =
    route === 'aws' ? 'AWS' : route === 'kiro' ? 'Kiro' : route === 'claude' ? 'Claude' : ''
  const label =
    id === 'claude-opus-5-5'
      ? 'Claude Opus 5.5'
      : id === 'claude-fable-5-2'
        ? 'Claude Fable 5.2'
        : name?.trim() || id
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
