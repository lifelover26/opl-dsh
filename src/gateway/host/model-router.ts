import { LlmError } from '../../shared/llm-error.ts' /** A logical source over explicit, independently credentialed model routes. */
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GatewayGroupId } from '../contracts/groups.ts'
import { modelDefaultEffort } from '../../shared/model-reasoning.ts'
export const OPENAI_PROVIDER = 'opl-gateway-openai'
export const AUTO_REVIEW_PROVIDER = 'opl-gateway-auto-review'
export const AUTO_REVIEW_MODEL = 'codex-auto-review'
export interface GatewayModelRoute {
  group: GatewayGroupId
  provider: string
  adapter: LlmAdapter
  available: () => Promise<boolean>
}
/** Unqualified DeepSeek ids remain stable; other groups have collision-free identities. */
export const gatewayModelId = (group: GatewayGroupId, id: string) =>
  group === 'deepseek' ? id : `${group}::${id}`

function withReasoning(model: LlmResolvedModelInfo): LlmResolvedModelInfo {
  const efforts = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'].includes(model.id)
    ? ['low', 'medium', 'high', 'xhigh', 'max']
    : model.id === 'claude-opus-5-5'
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : model.id === 'claude-fable-5-2'
        ? ['low', 'medium', 'high', 'xhigh', 'max']
        : model.id === 'grok-4.7'
          ? ['low', 'medium', 'high', 'xhigh']
          : undefined
  if (!efforts) {
    const effort = modelDefaultEffort(model.id, model.reasoning)
    return effort === undefined || !model.reasoning
      ? model
      : { ...model, reasoning: { ...model.reasoning, defaultEffort: ReasoningEffortId(effort) } }
  }
  const defaultEffort =
    model.id === 'grok-4.7' || model.id === 'claude-fable-5-2' ? 'high' : 'medium'
  return {
    ...model,
    reasoning: {
      efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })),
      defaultEffort: ReasoningEffortId(defaultEffort),
    },
  }
}
export class GatewayModelAdapter extends LlmAdapter {
  constructor(
    private readonly routes: readonly GatewayModelRoute[],
    private readonly onGroup: (group: GatewayGroupId) => void,
    private readonly reviewerRoute?: GatewayModelRoute,
  ) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: 'OPL Gateway' }
  }
  override providerRetryPolicy(provider: string) {
    return this.routes[0]!.adapter.providerRetryPolicy(provider)
  }
  override imageRequestPricing(_provider: string, model: string) {
    const index = model.indexOf('::'),
      group = index < 0 ? 'deepseek' : model.slice(0, index)
    const route = this.routes.find((route) => route.group === group)
    return route?.adapter.imageRequestPricing(
      route.provider,
      index < 0 ? model : model.slice(index + 2),
    )
  }
  override async listModels(provider: string) {
    const lists = await Promise.all(
      this.routes.map(async (route) => {
        if (!(await route.available())) return []
        return (await route.adapter.listModels(route.provider)).map((model) => ({
          ...withReasoning(model),
          provider,
          id: gatewayModelId(route.group, model.id),
        }))
      }),
    )
    const dedicatedId = gatewayModelId('codex', AUTO_REVIEW_MODEL)
    const models = lists.flat().filter((model) => !this.reviewerRoute || model.id !== dedicatedId)
    const reviewer = this.reviewerRoute
    if (reviewer && (await reviewer.available())) {
      const registered = await reviewer.adapter.listModels(reviewer.provider)
      const dedicated = registered.find((model) => model.id === AUTO_REVIEW_MODEL)
      if (dedicated) {
        return [...models, { ...dedicated, provider, id: dedicatedId }]
      }
    }
    return models
  }
  private async selection(model: string) {
    // Never infer a group from a model brand or from which request failed.
    const separator = model.indexOf('::')
    const group = separator < 0 ? 'deepseek' : model.slice(0, separator)
    const wireModel = separator < 0 ? model : model.slice(separator + 2)
    const route =
      group === 'codex' && wireModel === AUTO_REVIEW_MODEL && this.reviewerRoute
        ? this.reviewerRoute
        : this.routes.find((route) => route.group === group)
    if (!route) throw new LlmError('未知模型分组', 'UNKNOWN_MODEL')
    if (!(await route.available()))
      throw new LlmError(`${group} 分组凭据未就绪`, 'MISSING_CREDENTIAL')
    if (!(await route.adapter.listModels(route.provider)).some((item) => item.id === wireModel))
      throw new LlmError('模型未配置，请在模型设置中添加', 'UNKNOWN_MODEL')
    return { route, wireModel }
  }
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const { route, wireModel } = await this.selection(model)
    return {
      ...withReasoning(await route.adapter.resolveModel(route.provider, wireModel, signal)),
      provider,
      id: model,
    }
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const { route, wireModel } = await this.selection(model)
    const call = await route.adapter.prepareCall(route.provider, wireModel, signal)
    return {
      model: { ...withReasoning(call.model), provider, id: model },
      stream: (options: GenerateOptions) => this.dispatch(route, wireModel, call.stream, options),
    }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* (await this.prepareCall(options.provider, options.model, options.signal)).stream(options)
  }
  private async *dispatch(
    route: GatewayModelRoute,
    model: string,
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const messages = options.messages.map((message) => {
      if (message.role !== 'assistant' || message.source.kind !== 'model') return message
      const source = message.source
      const saved = (
        source.replayState as import('@deepseek-ai/dsh-llm').ReplayEnvelope | undefined
      )?.response as
        | { kind?: string; group?: string; provider?: string; model?: string; response?: unknown }
        | undefined
      if (
        saved?.kind === 'opl-group' &&
        saved.group === route.group &&
        saved.provider === route.provider &&
        saved.response !== undefined &&
        saved.model
      ) {
        return {
          ...message,
          source: {
            ...source,
            provider: route.provider,
            model: saved.model,
            replayState: {
              response: saved.response,
              ...((source.replayState as import('@deepseek-ai/dsh-llm').ReplayEnvelope).blocks
                ? {
                    blocks: (source.replayState as import('@deepseek-ai/dsh-llm').ReplayEnvelope)
                      .blocks,
                  }
                : {}),
            },
          },
        }
      }
      // Foreign groups must not pass their protocol-private replay state.
      const { replayState: _, ...neutral } = source
      return { ...message, source: neutral }
    })
    this.onGroup(route.group)
    for await (const chunk of stream({ ...options, provider: route.provider, model, messages })) {
      if (chunk.type === 'finish' && chunk.replayState) {
        yield {
          ...chunk,
          replayState: {
            response: {
              kind: 'opl-group',
              group: route.group,
              provider: route.provider,
              model,
              response: chunk.replayState.response,
            },
            ...(chunk.replayState.blocks ? { blocks: chunk.replayState.blocks } : {}),
          },
        }
      } else yield chunk
    }
  }
}
