/**
 * Source-group registration for the official Pi Coding Agent harness.
 *
 * This module is the bridge between the model source owner and this harness, and it is
 * deliberately the *only* place that couples the two. It adds no settings page and no
 * credential store: the owner keeps its own credentials, its own model list and its own
 * routing, and registers exactly the pairing it authorizes. A harness the owner does not
 * name, a model the harness does not pin, and a protocol the owner did not declare all
 * refuse rather than fall through to a default.
 *
 * Four ownership rules are enforced here rather than trusted:
 *
 * - **The source may authorize a pairing, never redirect it.** {@link resolve} requires
 *   the owner's answer to carry the model id and the protocol the combination already
 *   names. A source that returns a different id is refused, because accepting it would run
 *   a different model than the user selected.
 * - Each lane has its own catalog id and provider key; a route resolved for one is never
 *   reused for another.
 * - **No duplicate local source for one provider.** This harness consumes the shared
 *   `our-free-model` provider route that the OFM owner already publishes. Registering a
 *   second source under that same provider would shadow every other harness's pairing, so
 *   this module never claims a provider the owner has already registered; the shared
 *   registry refuses duplicates, and this module additionally refuses up front.
 * - **Credentials are resolved to authorize, and never injected here.** The adapter hands
 *   the key to the launched CLI through its own environment and the official `$ENV_VAR`
 *   interpolation, so the key is never written to a file, an argument vector, or a log.
 *
 * Register through {@link registerPiSource} so the source lives and dies inside the owner's
 * effect scope: unregistering the owner makes every later launch fail closed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { ExternalModelRoute, ExternalModelSource } from '../../model-sources.ts'
import {
  PI_CODE_MODELS,
  PI_HARNESS,
  PI_PROVIDER,
  isPiCodeModel,
  isPiProtocol,
  piApiForProtocol,
  piLane,
  piLaneProtocol,
  type PiProtocol,
} from './pi-models.ts'

/** What the model source owner must supply for one authorized pairing. */
export interface PiSourceAnswer {
  /** The owner's route base URL. Validated by the shared source registry. */
  readonly baseURL: string
  /** The owner's credential. Resolved for authorization; never stored here. */
  readonly apiKey: string
  /** The model id the owner serves. Must be the lane id the combination names. */
  readonly model: string
  /**
   * The wire protocol the owner's route speaks. Must equal the protocol this harness pins
   * for the lane; an incompatible answer is refused instead of being coerced.
   */
  readonly protocol: string
}

/** The one capability this source group needs from its owner. */
export type PiSourceOwner = (
  harness: string,
  ref: ModelRef,
) => Promise<PiSourceAnswer> | PiSourceAnswer

/**
 * Build the source this harness consumes.
 *
 * @param owner - the model source owner's resolver for this pairing.
 * @returns an {@link ExternalModelSource} for the harness to register publicly.
 */
export function createPiSource(owner: PiSourceOwner): ExternalModelSource {
  return {
    provider: PI_PROVIDER,
    supports(harness, ref) {
      // Only the exact harness and the exact lane ids this adapter pins. Another harness,
      // another provider, or a Pi-shaped id from a different owner is not absorbed here.
      return harness === PI_HARNESS && isPiCodeModel(ref)
    },
    async resolve(harness, ref) {
      const lane = piLane(ref)
      if (!lane) throw Error('该模型不属于官方 Pi 可固定的组合，已拒绝启动，不会改用其他模型')
      const answer = await owner(harness, ref)
      // A protocol outside the official API set is refused, not rounded to the nearest.
      if (!isPiProtocol(answer.protocol))
        throw Error('模型来源声明的协议不在官方 Pi 支持的范围内，已拒绝启动')
      const pinned = piLaneProtocol(ref)
      if (answer.protocol !== pinned)
        throw Error(
          `模型来源声明的协议（${answer.protocol}）与本组合固定的协议（${pinned}）不一致，已拒绝启动，不会改用其他协议`,
        )
      // Proves the official CLI has a provider API for this protocol before the route is
      // written into the provider config.
      piApiForProtocol(answer.protocol)
      if (answer.model !== lane.model)
        throw Error(
          `模型来源解析出的模型（${answer.model}）与所选组合（${lane.model}）不一致，已拒绝启动，不会改用来源返回的模型`,
        )
      if (answer.baseURL.trim().length === 0 || !answer.apiKey)
        throw Error('模型来源未提供兼容的执行参数，已拒绝启动')
      const route: ExternalModelRoute = {
        baseURL: answer.baseURL,
        // Pinned to the lane's own id: the owner authorizes this model, it does not get to
        // substitute a different one.
        model: lane.model,
        apiKey: answer.apiKey,
        protocol: answer.protocol as PiProtocol,
      }
      return route
    },
  }
}

/**
 * Register the source group with the official source registry.
 *
 * The registration is bound to `owner`'s effect scope, so unloading the owner removes the
 * source and every subsequent launch of this harness fails closed instead of falling back
 * to an unowned route.
 *
 * **Never shadows an existing provider route.** If the shared registry already carries a
 * source for {@link PI_PROVIDER} — which is the normal state, because the OFM plugin owns
 * that route for every harness — this refuses instead of registering a second source under
 * the same provider name, which would override the other harnesses' pairing. In that case
 * use the registry as it stands: this adapter resolves through the same shared route.
 *
 * @param ctx - the owner context whose scope holds the registration.
 * @param owner - the model source owner's resolver for this pairing.
 * @returns the unregister function.
 * @throws Error when the provider route is already registered by another owner.
 */
export function registerPiSource(ctx: Context, owner: PiSourceOwner): () => void {
  const sources = ctx.oplExternalModelSources
  // `supports` is the registry's own membership question for a provider: a source already
  // registered for it answers for at least one pairing. Every declared Pi lane is probed,
  // because the shared OFM source legitimately authorizes only *some* of them, and a
  // single miss would let a shadowing registration through for the other lanes.
  const alreadyOwned = PI_CODE_MODELS.some((model) =>
    sources.supports(PI_HARNESS, { provider: PI_PROVIDER, model }),
  )
  if (alreadyOwned)
    throw Error(
      `模型来源 ${PI_PROVIDER} 已由其他来源注册；已停止，未注册重复来源，以免覆盖其他 Harness 的组合绑定。`,
    )
  return sources.register(ctx, createPiSource(owner))
}
