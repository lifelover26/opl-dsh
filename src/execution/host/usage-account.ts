import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { HarnessContextUsage, HarnessStatistics } from '../contracts/usage.ts'

/** Optional usage facts collected from one completed external Harness operation. */
export type ExternalUsageAccount = HarnessStatistics

type ObjectValue = Record<string, unknown>

const isObject = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const sum = (...values: number[]): number | undefined => {
  let result = 0
  for (const value of values) {
    result += value
    if (!Number.isSafeInteger(result)) return undefined
  }
  return result
}

interface UsageBuckets {
  readonly input: number
  readonly output: number
  readonly total?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly reasoning?: number
}

function usageFromBuckets(buckets: UsageBuckets): TokenUsage | undefined {
  const knownInput = sum(buckets.input, buckets.cacheRead ?? 0, buckets.cacheWrite ?? 0)
  const knownTotal = sum(knownInput ?? 0, buckets.output)
  if (knownInput === undefined || knownTotal === undefined) return undefined
  if (buckets.total !== undefined && buckets.total !== knownTotal) return undefined
  if (buckets.reasoning !== undefined && buckets.reasoning > buckets.output) return undefined
  return {
    inputTokens: buckets.input,
    outputTokens: buckets.output,
    totalTokens: buckets.total === undefined ? knownTotal : buckets.total,
    ...(buckets.cacheRead === undefined ? {} : { cacheReadTokens: buckets.cacheRead }),
    ...(buckets.cacheWrite === undefined ? {} : { cacheWriteTokens: buckets.cacheWrite }),
    ...(buckets.reasoning === undefined ? {} : { reasoningTokens: buckets.reasoning }),
  }
}

function parseUsageObject(
  value: unknown,
  options: {
    readonly inputIncludesCache: boolean
    readonly inputKey?: string
    readonly outputKey?: string
    readonly totalKey?: string
    readonly cacheReadKey?: string
    readonly cacheWriteKey?: string
    readonly reasoningKey?: string
  },
): TokenUsage | undefined {
  if (!isObject(value)) return undefined
  const inputKey = options.inputKey ?? 'inputTokens'
  const outputKey = options.outputKey ?? 'outputTokens'
  const totalKey = options.totalKey ?? 'totalTokens'
  const cacheReadKey = options.cacheReadKey ?? 'cachedReadTokens'
  const cacheWriteKey = options.cacheWriteKey ?? 'cachedWriteTokens'
  const reasoningKey = options.reasoningKey ?? 'reasoningTokens'
  const rawInput = integer(value[inputKey])
  const output = integer(value[outputKey])
  if (rawInput === undefined || output === undefined) return undefined
  const totalRaw = value[totalKey]
  const cacheReadRaw = value[cacheReadKey]
  const cacheWriteRaw = value[cacheWriteKey]
  const reasoningRaw = value[reasoningKey]
  for (const raw of [totalRaw, cacheReadRaw, cacheWriteRaw, reasoningRaw]) {
    if (raw !== undefined && integer(raw) === undefined) return undefined
  }
  const cacheRead = cacheReadRaw === undefined ? undefined : integer(cacheReadRaw)
  const cacheWrite = cacheWriteRaw === undefined ? undefined : integer(cacheWriteRaw)
  const input = options.inputIncludesCache
    ? (sum(rawInput, -(cacheRead ?? 0), -(cacheWrite ?? 0)) ?? -1)
    : rawInput
  if (input < 0) return undefined
  const total = totalRaw === undefined ? undefined : integer(totalRaw)
  const reasoning = reasoningRaw === undefined ? undefined : integer(reasoningRaw)
  return usageFromBuckets({
    input,
    output,
    ...(total === undefined ? {} : { total }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoning }),
  })
}

/**
 * Parse Grok Build's per-turn aggregate from `PromptResponse._meta.usage`.
 * @param value - Complete Grok prompt response.
 * @param modelCatalog - Optional model metadata returned by Grok's model catalog.
 * @returns Per-turn billing usage and independently observed live context.
 */
export function parseGrokTurnUsage(value: unknown, modelCatalog?: unknown): ExternalUsageAccount {
  const meta = isObject(value) && isObject(value._meta) ? value._meta : undefined
  if (meta === undefined) return {}
  const usage = parseUsageObject(meta.usage, {
    inputIncludesCache: true,
    cacheWriteKey: 'cacheCreationTokens',
  })
  const contextUsage = grokContextUsage(meta, modelCatalog)
  return {
    ...(usage === undefined ? {} : { usage }),
    ...(contextUsage === undefined ? {} : { contextUsage }),
  }
}

/**
 * Parse Pool's per-response usage; cache reads are a subset of `inputTokens`.
 * @param value - Complete Pool prompt response.
 * @returns Per-response billing usage, or an empty account when malformed.
 */
export function parsePoolTurnUsage(value: unknown): ExternalUsageAccount {
  const response = isObject(value) ? value : undefined
  const usage =
    response === undefined
      ? undefined
      : parseUsageObject(response.usage, { inputIncludesCache: true })
  return usage === undefined ? {} : { usage }
}

/**
 * Parse the verified OpenCode/Kilo ACP result when the local history read is delayed.
 * The official result uses input/output/total buckets; Kilo additionally publishes
 * thoughtTokens and cachedReadTokens. The persisted message graph remains the preferred
 * source, but this result is a valid fallback for the completed prompt.
 * @param value - Complete ACP prompt result.
 * @returns Per-prompt usage when the arithmetic is self-consistent.
 */
export function parseOpenCodeKiloTurnUsage(value: unknown): ExternalUsageAccount {
  const response = isObject(value) ? value : undefined
  const usage = response && isObject(response.usage) ? response.usage : undefined
  if (!usage) return {}
  const inputRaw = integer(usage.inputTokens)
  const outputRaw = integer(usage.outputTokens)
  const total = integer(usage.totalTokens)
  const reasoningRaw = usage.reasoningTokens ?? usage.thoughtTokens
  const reasoning = reasoningRaw === undefined ? undefined : integer(reasoningRaw)
  const cacheReadRaw = usage.cachedReadTokens ?? usage.cacheReadTokens
  const cacheWriteRaw = usage.cachedWriteTokens ?? usage.cacheWriteTokens
  const cacheRead = cacheReadRaw === undefined ? undefined : integer(cacheReadRaw)
  const cacheWrite = cacheWriteRaw === undefined ? undefined : integer(cacheWriteRaw)
  if (
    inputRaw === undefined ||
    outputRaw === undefined ||
    total === undefined ||
    (reasoningRaw !== undefined && reasoning === undefined) ||
    (cacheReadRaw !== undefined && cacheRead === undefined) ||
    (cacheWriteRaw !== undefined && cacheWrite === undefined)
  )
    return {}
  const input = inputRaw
  const output = sum(outputRaw, reasoning ?? 0)
  if (input === undefined || input < 0 || output === undefined) return {}
  const expected = sum(input, cacheRead ?? 0, cacheWrite ?? 0, output)
  if (expected === undefined || expected !== total) return {}
  return {
    usage: {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    },
  }
}

/**
 * Parse Pool's context update, accepting the direct ACP update or its envelope.
 * @param value - ACP context update or its enclosing update event.
 * @returns Valid context occupancy fields, or an empty account.
 */
export function parsePoolContextUsage(value: unknown): ExternalUsageAccount {
  return parseContextAccount(value)
}

/**
 * Parse MiniMax's ACP context occupancy independently of its per-turn token counters.
 * @param value - ACP context update or its enclosing update event.
 * @returns Valid context occupancy fields, or an empty account.
 */
export function parseMiniMaxContextUsage(value: unknown): ExternalUsageAccount {
  return parseContextAccount(value)
}

/**
 * Aggregate official MiniMax usage rows belonging to one native turn and model.
 * @param value - Token-only rows from the official local session usage service.
 * @param turnId - Native turn already bound to the current DSH operation.
 * @param model - Selected official MiniMax model id, without its provider prefix.
 * @returns Disjoint token buckets, or undefined for missing or inconsistent records.
 */
export function parseMiniMaxTurnUsage(
  value: unknown,
  turnId: string,
  model: string,
): TokenUsage | undefined {
  if (!turnId || !model || !Array.isArray(value)) return undefined
  const rows = value.filter((row) => isObject(row) && row.turnId === turnId)
  if (!rows.length) return undefined
  const ids = new Set<number>()
  const fields = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const
  const totals = new Map<(typeof fields)[number], number>()
  for (const row of rows) {
    if (
      !isObject(row) ||
      integer(row.id) === undefined ||
      Number(row.id) === 0 ||
      ids.has(Number(row.id)) ||
      row.model !== `minimax/${model}`
    )
      return undefined
    ids.add(Number(row.id))
    for (const key of fields) {
      const count = row[key]
      if (count === undefined && key === 'reasoningTokens') continue
      const n = integer(count)
      if (n === undefined) return undefined
      const total = sum(totals.get(key) ?? 0, n)
      if (total === undefined) return undefined
      totals.set(key, total)
    }
    if (row.reasoningTokens !== undefined && Number(row.reasoningTokens) > Number(row.outputTokens))
      return undefined
  }
  for (const key of fields.slice(2)) {
    if (totals.has(key) && rows.some((row) => !isObject(row) || row[key] === undefined))
      return undefined
  }
  return usageFromBuckets({
    input: totals.get('inputTokens')!,
    output: totals.get('outputTokens')!,
    cacheRead: totals.get('cacheReadTokens')!,
    cacheWrite: totals.get('cacheWriteTokens')!,
    ...(totals.has('reasoningTokens') ? { reasoning: totals.get('reasoningTokens')! } : {}),
  })
}

function parseContextAccount(value: unknown): ExternalUsageAccount {
  const source = isObject(value) ? (isObject(value.update) ? value.update : value) : undefined
  if (!source) return {}
  const usedRaw = source.used
  const sizeRaw = source.size
  if (usedRaw !== undefined && integer(usedRaw) === undefined) return {}
  if (sizeRaw !== undefined && integer(sizeRaw) === undefined) return {}
  const used = usedRaw === undefined ? undefined : integer(usedRaw)
  const size = sizeRaw === undefined ? undefined : integer(sizeRaw)
  const estimatedRaw = source.estimated
  if (estimatedRaw !== undefined && typeof estimatedRaw !== 'boolean') return {}
  if (used === undefined && size === undefined) return {}
  if (size !== undefined && size === 0) return {}
  if (used !== undefined && size !== undefined && used > size) return {}
  return {
    contextUsage: {
      ...(used === undefined ? {} : { used }),
      ...(size === undefined ? {} : { size }),
      ...(estimatedRaw === undefined ? {} : { estimated: estimatedRaw }),
    },
  }
}

function grokContextUsage(
  meta: ObjectValue,
  modelCatalog?: unknown,
): HarnessContextUsage | undefined {
  const used = integer(meta.totalTokens)
  if (used === undefined) return undefined
  const modelId = typeof meta.modelId === 'string' ? meta.modelId : undefined
  const catalog = isObject(modelCatalog) ? modelCatalog : {}
  const catalogMeta = isObject(catalog._meta) ? catalog._meta : {}
  const state = isObject(meta.modelState)
    ? meta.modelState
    : isObject(catalogMeta.modelState)
      ? catalogMeta.modelState
      : isObject(catalog.modelState)
        ? catalog.modelState
        : catalog
  const availableModels = Array.isArray(state.availableModels) ? state.availableModels : []
  const models = availableModels.filter(isObject)
  const matching = modelId
    ? models.filter((model) => model.id === modelId || model.modelId === modelId)
    : []
  const candidates = matching.length > 0 ? matching : models
  const sizes = candidates
    .map((model) => {
      const metadata = isObject(model._meta) ? model._meta : undefined
      return metadata ? integer(metadata.totalContextTokens) : undefined
    })
    .filter((size): size is number => size !== undefined && size > 0)
  const uniqueSizes = [...new Set(sizes)]
  const size = uniqueSizes.length === 1 ? uniqueSizes[0] : undefined
  if (size !== undefined && used > size) return undefined
  return { used, ...(size === undefined ? {} : { size }), estimated: true }
}

/**
 * Convert Kimi transcript usage into disjoint DSH counters when source buckets permit it.
 * @param value - One official Kimi transcript turn.
 * @returns Canonical turn usage only when native step buckets are present.
 */
export function parseKimiTranscriptUsage(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined
  const steps = Array.isArray(value.steps) ? value.steps : []
  const usageSteps = steps.filter((step) => isObject(step) && step.usage !== undefined)
  if (usageSteps.length > 0) {
    let inputOther = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    for (const rawStep of usageSteps) {
      if (!isObject(rawStep) || !isObject(rawStep.usage)) return undefined
      const step = rawStep.usage
      const values = [
        integer(step.inputOther),
        integer(step.output),
        integer(step.inputCacheRead),
        integer(step.inputCacheCreation),
      ]
      if (values.some((item) => item === undefined)) return undefined
      inputOther = sum(inputOther, values[0]!) ?? -1
      output = sum(output, values[1]!) ?? -1
      cacheRead = sum(cacheRead, values[2]!) ?? -1
      cacheWrite = sum(cacheWrite, values[3]!) ?? -1
      if ([inputOther, output, cacheRead, cacheWrite].some((item) => item < 0)) return undefined
    }
    return usageFromBuckets({ input: inputOther, output, cacheRead, cacheWrite })
  }
  // Kimi's aggregate folds cache creation into inputTokens, so it cannot be
  // projected into disjoint uncached/cache-write buckets without the steps.
  return undefined
}

/**
 * Read every page of Kimi's main-agent transcript and retain usage by exact turn id.
 * @param readPage - Function that reads the requested page before the supplied turn id.
 * @returns Usage keyed by native turn id; malformed or incomplete pages reject.
 */
export async function readKimiTranscriptUsages(
  readPage: (beforeTurn?: string) => Promise<unknown>,
): Promise<Map<string, TokenUsage>> {
  const usages = new Map<string, TokenUsage>()
  const seenTurnIds = new Set<string>()
  const cursors = new Set<string>()
  let beforeTurn: string | undefined
  for (;;) {
    const envelope = await readPage(beforeTurn)
    if (!isObject(envelope) || envelope.code !== 0 || !isObject(envelope.data))
      throw Error('Kimi transcript response is invalid')
    const data = envelope.data
    if (!Array.isArray(data.items) || typeof data.has_more !== 'boolean')
      throw Error('Kimi transcript page is incomplete')
    const turnIds: string[] = []
    for (const raw of data.items) {
      if (!isObject(raw) || raw.kind !== 'turn') continue
      if (typeof raw.turnId !== 'string' || !raw.turnId)
        throw Error('Kimi transcript turn is missing its id')
      if (seenTurnIds.has(raw.turnId)) throw Error('Kimi transcript repeated a turn')
      seenTurnIds.add(raw.turnId)
      turnIds.push(raw.turnId)
      const usage = parseKimiTranscriptUsage(raw)
      if (usage) {
        const prior = usages.get(raw.turnId)
        if (prior && JSON.stringify(prior) !== JSON.stringify(usage))
          throw Error('Kimi transcript repeated a turn with different usage')
        usages.set(raw.turnId, usage)
      }
    }
    if (!data.has_more) return usages
    const next = turnIds[0]
    if (!next || next === beforeTurn || cursors.has(next))
      throw Error('Kimi transcript pagination cursor did not advance')
    cursors.add(next)
    beforeTurn = next
  }
}

/**
 * Read exact current context occupancy from Kimi's local session status response.
 * @param value - Official Kimi session-status response.
 * @returns Available context occupancy fields, or undefined when absent or invalid.
 */
export function parseKimiContextUsage(value: unknown): HarnessContextUsage | undefined {
  if (!isObject(value) || value.code !== 0 || !isObject(value.data)) return undefined
  const status = value.data
  const used = integer(status.context_tokens)
  const size = integer(status.max_context_tokens)
  if (status.context_tokens !== undefined && used === undefined) return undefined
  if (status.max_context_tokens !== undefined && size === undefined) return undefined
  if (size === 0 || (used !== undefined && size !== undefined && used > size)) return undefined
  if (used === undefined && size === undefined) return undefined
  return { ...(used === undefined ? {} : { used }), ...(size === undefined ? {} : { size }) }
}
