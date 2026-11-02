/**
 * Explicit external-execution source for the original `dsh-our-free-model`
 * plugin, registered through the suite's public `ctx.oplExternalModelSources`.
 *
 * This is a pairing layer, not a second OFM. The plugin keeps its catalog,
 * channels, rotation chain, credentials and updater; this module decides only
 * which Harness may run which model on which provider route, and it re-proves
 * that pairing against the plugin's live catalog at launch time.
 *
 * Two boundaries do the real work:
 *
 * - **The owner owns the catalog.** `supports()` may only answer synchronously,
 *   so it uses a declared pairing plus provider registration; membership is
 *   proven in `resolve()`, which asks the live registry. `resolveModelInfo` alone
 *   is not treated as the catalog: upstream synthesizes metadata for unknown ids,
 *   so a current-model answer comes from `listModels`, and the exact identity is
 *   re-proven after the connection await.
 * - **Nothing is inferred.** A structurally valid id is not availability, an
 *   excluded model stays excluded even when the plugin lists it, and no endpoint,
 *   key or protocol is ever derived from a name.
 *
 * @module ofm-source/source
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelRef } from '../../contracts/catalog.ts'
import type {
  ExternalModelRoute,
  ExternalModelSource,
  ExternalWireProtocol,
} from '../model-sources.ts'
import {
  OFM_PROVIDER,
  OFM_PROVIDERS,
  isExcludedOfmModel,
  isUsableOfmModelId,
  ofmHarnessPinsModel,
  ofmProtocol,
  type OfmWireProtocol,
} from './provider.ts'

/** Connection facts the plugin owner publishes, and nothing else. */
export interface OfmConnectionFacts {
  baseURL: string
  apiKey: string
  protocols?: readonly ExternalWireProtocol[]
}

/**
 * Supplied by the plugin owner, normally by
 * {@link createOfmApiConnection}. `undefined` is an explicit refusal — a stopped
 * lane, a withdrawn channel, an admission rejection — and fails the launch
 * instead of falling back to another route or another model.
 */
export type OfmConnectionReader = (
  harness: string,
  ref: ModelRef,
  protocol: ExternalWireProtocol,
) => Promise<OfmConnectionFacts | undefined>

export interface OfmModelSourceOptions {
  /** Owner-supplied connection facts. Omit to register a source that only pairs. */
  connection?: OfmConnectionReader
  /** Protocol declarations for Harnesses added after this table was written. */
  protocols?: Readonly<Record<string, OfmWireProtocol>>
  /** Which provider routes this source claims. Defaults to both plugin routes. */
  providers?: readonly string[]
}

const registered = (ctx: Context, provider: string): boolean =>
  (ctx.llm?.listProviders() ?? []).some((entry) => entry.id === provider)

/**
 * Ask the owning adapter's live catalog whether it currently serves a model.
 *
 * There is deliberately no `resolveModelInfo` fallback here. Upstream answers
 * exact-model resolution for ids that are not in its catalog, so a runtime
 * without `listModels` cannot prove existence, and a refusal is the honest
 * answer.
 */
async function liveCatalogHas(ctx: Context, provider: string, model: string): Promise<boolean> {
  const llm = ctx.llm
  if (typeof llm?.listModels !== 'function') return false
  try {
    return (await llm.listModels(provider)).some((entry) => entry.id === model)
  } catch {
    return false
  }
}

/** Build the source for one provider route. */
export function createOfmModelSource(
  ctx: Context,
  options: OfmModelSourceOptions = {},
  provider: string = OFM_PROVIDER,
): ExternalModelSource {
  return {
    provider,

    /**
     * Synchronous, so it answers from declared facts only: this provider route is
     * registered right now, the Harness declares a protocol, the id is usable and
     * not excluded, and a Harness that pins models pins this one. Live membership
     * and late revocation are proven in `resolve()`.
     */
    supports(harness, ref) {
      if (ref.provider !== provider) return false
      if (!isUsableOfmModelId(ref.model)) return false
      if (isExcludedOfmModel(ref.model)) return false
      if (ofmProtocol(harness, options.protocols) === undefined) return false
      if (!ofmHarnessPinsModel(harness, ref.model)) return false
      return registered(ctx, provider)
    },

    async resolve(harness, ref): Promise<ExternalModelRoute> {
      const protocol = ofmProtocol(harness, options.protocols)
      if (protocol === undefined) throw Error(`Our Free Model 未适配 Harness「${harness}」`)
      if (ref.provider !== provider) throw Error('模型不属于 Our Free Model 插件')
      if (!isUsableOfmModelId(ref.model)) throw Error('模型标识无效')
      if (isExcludedOfmModel(ref.model)) throw Error(`模型「${ref.model}」未纳入本次适配范围`)
      if (!ofmHarnessPinsModel(harness, ref.model))
        throw Error(`模型「${ref.model}」未分配给 Harness「${harness}」`)
      if (!registered(ctx, provider)) throw Error('Our Free Model 插件尚未加载或已卸载该渠道')
      if (!(await liveCatalogHas(ctx, provider, ref.model)))
        throw Error(`Our Free Model 当前目录未提供模型「${ref.model}」`)

      if (!options.connection)
        throw Error(
          'Our Free Model 插件尚未通过公开接口提供外部执行端点；' +
            '需要插件所有者注入经正常准入的连接读取器',
        )
      const facts = await options.connection(harness, ref, protocol)
      if (!facts) throw Error('Our Free Model 未提供可用的外部执行端点')
      if (facts.protocols !== undefined && !facts.protocols.includes(protocol))
        throw Error('Our Free Model 端点不支持该 Harness 的协议')

      // Exact-model identity, before the final catalog read. Upstream synthesizes
      // this for unknown ids, so it can only ever agree on identity; it is not
      // evidence that the model exists.
      let owned: { provider?: string; id?: string; context?: { contextWindow: number } } | undefined
      try {
        owned = await ctx.llm.resolveModelInfo(provider, ref.model)
      } catch {
        throw Error(`Our Free Model 已不再提供模型「${ref.model}」`)
      }
      if (owned?.provider !== provider || owned?.id !== ref.model)
        throw Error('Our Free Model 返回的模型身份与请求不一致')

      // The last asynchronous read decides existence. A revocation can land during
      // the metadata await above, so the catalog is re-read afterwards and is the
      // final verdict; an earlier read is never treated as still valid.
      if (!(await liveCatalogHas(ctx, provider, ref.model)))
        throw Error(`Our Free Model 当前目录已移除模型「${ref.model}」`)
      // Synchronous lifetime recheck directly after the final await, with no
      // further suspension point between it and returning the route.
      if (!registered(ctx, provider)) throw Error('Our Free Model 插件已卸载该渠道')
      const capacity = owned.context?.contextWindow
      return {
        baseURL: facts.baseURL,
        model: ref.model,
        apiKey: facts.apiKey,
        protocol,
        ...(typeof capacity === 'number' && Number.isSafeInteger(capacity) && capacity > 0
          ? { contextWindow: capacity }
          : {}),
      }
    },
  }
}

/**
 * Register one source per declared provider route, in the mounting plugin's
 * effect scope. Every route this source claims is registered by default, so a
 * provider the implementation advertises is never missing from the shared
 * lookup. A route the plugin has not actually registered is refused by
 * `supports` rather than bypassing the real registry.
 */
export function applyOfmModelSource(ctx: Context, options: OfmModelSourceOptions = {}): () => void {
  const disposers = (options.providers ?? OFM_PROVIDERS).map((provider) =>
    ctx.oplExternalModelSources.register(ctx, createOfmModelSource(ctx, options, provider)),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}
