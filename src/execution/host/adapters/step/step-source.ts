/**
 * Source-group registration for the official StepCode harness.
 *
 * This module is the bridge between the model source owner and this harness, and it is
 * deliberately the *only* place that couples the two. It adds no settings page and no
 * credential store: the owner keeps its own credentials, its own model list and its own
 * routing, and registers exactly the pairing it authorizes. A harness the owner does not
 * name, a model the harness does not pin, and a protocol the owner did not declare all
 * refuse rather than fall through to a default.
 *
 * Three ownership rules are enforced here rather than trusted:
 *
 * - **The source may authorize a pairing, never redirect it.** {@link resolve} requires
 *   the owner's answer to carry the model id and the protocol the combination already
 *   names. A source that returns a different id is refused, because accepting it would
 *   run a different model than the user selected.
 * - **The two lanes stay separate.** `step-5-preview-free` and
 *   `stepfun/step-5-preview-free` are two catalog entries with two provider keys; a
 *   route resolved for one is never reused for the other.
 * - **Credentials are resolved to authorize, and never injected here.** The adapter
 *   hands the key to the launched CLI through its own environment and the official
 *   `$ENV_VAR` interpolation, so the key is never written to a file, an argument vector,
 *   or a log. Nothing in this module reads, logs, or stores a token.
 *
 * Register through {@link registerStepCodeSource} so the source lives and dies inside the
 * owner's effect scope: unregistering the owner makes every later launch fail closed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { ExternalModelSource } from '../../model-sources.ts'
import {
  STEP_HARNESS,
  STEP_PROVIDER,
  isStepCodeModel,
  isStepProtocol,
  stepApiForProtocol,
  stepLane,
  stepLaneProtocol,
  type StepProtocol,
} from './step-models.ts'

/** What the model source owner must supply for one authorized pairing. */
export interface StepSourceAnswer {
  /** The owner's route base URL. Validated by the shared source registry. */
  readonly baseURL: string
  /** The owner's credential. Resolved for authorization; never stored here. */
  readonly apiKey: string
  /** The model id the owner serves. Must be the lane id the combination names. */
  readonly model: string
  /**
   * The wire protocol the owner's route speaks. Must equal the protocol this harness
   * pins for the lane; an incompatible answer is refused instead of being coerced.
   */
  readonly protocol: string
  /** Source-configured context budget; absence leaves Step's effective runtime window unchanged. */
  readonly contextWindow?: number
}

/** The one capability this source group needs from its owner. */
export type StepSourceOwner = (
  harness: string,
  ref: ModelRef,
) => Promise<StepSourceAnswer> | StepSourceAnswer

/**
 * Validate a route the **central** OFM source owner already resolved for this pairing.
 *
 * This is the normal path. The central owner registers `our-free-model` once for the
 * whole suite, and this adapter consumes it through
 * `options.modelSources.resolve`. Requiring a second registration for the same provider
 * would either collide with the central one (`ExternalModelSources` keys by provider and
 * rejects a duplicate) or split credential ownership across two owners, so nothing here
 * registers a provider that already exists.
 *
 * The validator is exported separately so the composition point can apply exactly the
 * same rules to a centrally resolved route: the declared protocol, the exact lane id, and
 * a real official API for that protocol.
 *
 * @param harness - the Harness the central owner resolved for.
 * @param ref - the exact model reference the combination names.
 * @param route - the resolved route from the central owner.
 * @throws Error when the route is not this harness's pairing.
 */
export function assertStepRouteForPairing(
  harness: string,
  ref: ModelRef,
  route: { baseURL: string; model: string; apiKey: string; protocol: string },
): void {
  const lane = stepLane(ref)
  if (!lane || harness !== STEP_HARNESS)
    throw Error('该模型不属于官方 StepCode 可固定的组合，已拒绝启动，不会改用其他模型')
  // A protocol outside the official API set is refused, not rounded to the nearest.
  if (!isStepProtocol(route.protocol))
    throw Error('模型来源声明的协议不在官方 StepCode 支持的范围内，已拒绝启动')
  const pinned = stepLaneProtocol(ref)
  if (route.protocol !== pinned)
    throw Error(
      `模型来源声明的协议（${route.protocol}）与本组合固定的协议（${pinned}）不一致，已拒绝启动，不会改用其他协议`,
    )
  // Proves the official CLI has a provider API for this protocol before the route is
  // written into the provider config.
  stepApiForProtocol(route.protocol)
  if (route.model !== lane.model)
    throw Error(
      `模型来源解析出的模型（${route.model}）与所选组合（${lane.model}）不一致，已拒绝启动，不会改用来源返回的模型`,
    )
  if (route.baseURL.trim().length === 0 || !route.apiKey)
    throw Error('模型来源未提供兼容的执行参数，已拒绝启动')
}

/**
 * Build a StepCode-scoped source for a **standalone** owner.
 *
 * Only for a deployment that has no central `our-free-model` owner. It registers the
 * same provider key the central owner would, so exactly one of the two may be used: with
 * a central owner registered, calling this throws `已注册` by design rather than quietly
 * shadowing it. Prefer {@link assertStepRouteForPairing} on the central route.
 *
 * @param owner - the model source owner's resolver for this pairing.
 * @returns an {@link ExternalModelSource} for the harness to register publicly.
 */
export function createStepCodeSource(owner: StepSourceOwner): ExternalModelSource {
  return {
    provider: STEP_PROVIDER,
    supports(harness, ref) {
      // Only the exact harness and the exact lane ids this adapter pins. Another
      // harness, another provider, or a Step-shaped id from a different owner is not
      // absorbed here.
      return harness === STEP_HARNESS && isStepCodeModel(ref)
    },
    async resolve(harness, ref) {
      const lane = stepLane(ref)
      if (!lane) throw Error('该模型不属于官方 StepCode 可固定的组合，已拒绝启动，不会改用其他模型')
      const route = await owner(harness, ref)
      assertStepRouteForPairing(harness, ref, route)
      return {
        baseURL: route.baseURL,
        // Pinned to the lane's own id: the owner authorizes this model, it does not get
        // to substitute a different one.
        model: lane!.model,
        apiKey: route.apiKey,
        protocol: route.protocol as StepProtocol,
        ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
      }
    },
  }
}

/**
 * Register a **standalone** StepCode owner with the official source registry.
 *
 * Mutually exclusive with a central `our-free-model` owner, which must keep the single
 * registration for the whole suite. The registration is bound to `owner`'s effect scope,
 * so unloading the owner makes every later launch fail closed.
 *
 * @param ctx - the owner context whose scope holds the registration.
 * @param owner - the model source owner's resolver for this pairing.
 * @returns the unregister function.
 */
export function registerStepCodeSource(ctx: Context, owner: StepSourceOwner): () => void {
  return ctx.oplExternalModelSources.register(ctx, createStepCodeSource(owner))
}
