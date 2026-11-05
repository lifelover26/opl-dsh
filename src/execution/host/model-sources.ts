/** External CLI routes resolved by the model-source owner, without copying provider settings. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelRef } from '../contracts/catalog.ts'
import { resolveGatewayExecution } from '../../gateway/host/execution-access.ts'

export type ExternalWireProtocol = 'responses' | 'messages' | 'chat'
/** Host-only resolved data; credentials never enter catalog/capability responses. */
export interface ExternalModelRoute {
  baseURL: string
  model: string
  apiKey: string
  protocol: ExternalWireProtocol
  /** Source-owned configured context budget; it is not a provider-side capacity probe. */
  contextWindow?: number
  /** The exact source advertises image input; absent routes remain text-only. */
  imageInput?: boolean
}
/** One source explicitly declares supported model/Harness pairs and owns route resolution. */
export interface ExternalModelSource {
  provider: string
  supports(harness: string, ref: ModelRef): boolean
  resolve(harness: string, ref: ModelRef): Promise<ExternalModelRoute>
}

/** Registration and declared pairing captured before asynchronous CLI preparation. */
export interface ExternalModelSourceLease {
  /** Reject if the captured registration or its declared pairing no longer exists. */
  assertCurrent(): void
}

/** Routes are registered by their owner; names alone never select a provider or account. */
export class ExternalModelSources {
  private readonly sources = new Map<string, { source: ExternalModelSource }>()
  constructor(
    private readonly ctx: Context,
    private readonly changed: () => void = () => {},
  ) {}

  /** Register through the contributing plugin's effect scope; duplicate ownership is refused. */
  register(owner: Context, source: ExternalModelSource): () => void {
    if (
      !source.provider.trim() ||
      source.provider === 'opl-gateway' ||
      this.sources.has(source.provider)
    )
      throw Error('外部模型来源已注册或身份无效')
    return owner.effect(() => {
      const registration = { source }
      this.sources.set(source.provider, registration)
      this.changed()
      return () => {
        if (this.sources.get(source.provider) === registration) this.sources.delete(source.provider)
        this.changed()
      }
    })
  }

  /** Only an explicit registration can add a non-Gateway source to an external adapter. */
  supports(harness: string, ref: ModelRef): boolean {
    return this.sources.get(ref.provider)?.source.supports(harness, ref) === true
  }

  /**
   * Capture a registered external source before resolving its route. Adapters
   * check the lease after their final asynchronous preflight and immediately
   * before returning a launch. Source owners still validate live catalog and
   * connection data; this lease covers registration lifetime and declared pairing.
   * @param harness - requested Harness identity.
   * @param ref - exact provider and model to retain throughout preparation.
   * @returns a synchronous check bound to this registration, including re-registration.
   */
  lease(harness: string, ref: ModelRef): ExternalModelSourceLease {
    const captured = { provider: ref.provider, model: ref.model }
    const registration = this.sources.get(captured.provider)
    if (!registration?.source.supports(harness, captured))
      throw Error('该模型来源尚未适配此 Harness')
    return {
      assertCurrent: () => {
        if (
          this.sources.get(captured.provider) !== registration ||
          !registration.source.supports(harness, captured)
        )
          throw Error('模型来源已变更，请重新选择')
      },
    }
  }

  /** Resolve the exact source and verify wire data before any profile write or CLI launch. */
  async resolve(
    harness: string,
    ref: ModelRef,
    protocol: ExternalWireProtocol,
  ): Promise<ExternalModelRoute> {
    let route: ExternalModelRoute
    if (ref.provider === 'opl-gateway') {
      const resolved = await resolveGatewayExecution(this.ctx, ref)
      const wire: Record<string, ExternalWireProtocol> = {
        'openai-responses': 'responses',
        'anthropic-messages': 'messages',
        'openai-completions': 'chat',
      }
      const expected = wire[resolved.api]
      if (expected !== protocol) throw Error('所选来源的协议与 Harness 不兼容')
      route = { ...resolved, protocol: expected }
    } else {
      const registration = this.sources.get(ref.provider)
      const source = registration?.source
      if (!source?.supports(harness, ref)) throw Error('该模型来源尚未适配此 Harness')
      route = await source.resolve(harness, ref)
      // A source removed/replaced during an asynchronous read cannot authorize a new launch.
      if (this.sources.get(ref.provider) !== registration || !source.supports(harness, ref))
        throw Error('模型来源已变更，请重新选择')
    }
    const url = new URL(route.baseURL)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !route.model?.trim() ||
      /[\r\n\0]/.test(route.model) ||
      !route.apiKey ||
      route.protocol !== protocol
    )
      throw Error('模型来源未提供兼容的执行参数')
    if (
      route.contextWindow !== undefined &&
      (!Number.isSafeInteger(route.contextWindow) || route.contextWindow <= 0)
    )
      throw Error('模型来源提供了无效的上下文容量')
    if (route.imageInput !== undefined && typeof route.imageInput !== 'boolean')
      throw Error('模型来源提供了无效的图片能力')
    return route
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Source owners may register explicit external CLI routes through their effect scope. */
    oplExternalModelSources: ExternalModelSources
  }
}
