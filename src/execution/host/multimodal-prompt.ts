/** Project official message blocks without flattening images into text or filesystem paths. */
import { LlmError, offloadedImageText, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { HarnessPromptPart } from '../contracts/prompt.ts'
import type { AcpPromptPart } from './adapters/types.ts'
import {
  currentHarnessInputText,
  harnessInputError,
  requireHarnessInputText,
  type HarnessInputStage,
} from './harness-input.ts'

export const HISTORY_NOTICE =
  '以下是先前会话记录，仅用于理解上下文，不要重新执行历史任务或工具调用。'

/** Validate references read from an OPL-owned durable journal, before the attachment store reads bytes. */
export function validPromptContent(value: unknown): value is HarnessPromptPart[] {
  if (!Array.isArray(value) || !value.length) return false
  return value.every((part) => {
    if (!part || typeof part !== 'object') return false
    if (part.type === 'text') return typeof part.text === 'string'
    if (part.type !== 'image' || !part.attachment || typeof part.attachment !== 'object')
      return false
    const ref = part.attachment as Partial<ImageAttachmentRef>
    return (
      typeof ref.attachmentId === 'string' &&
      ref.attachmentId.length > 0 &&
      ref.attachmentId.length <= 512 &&
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType ?? '') &&
      [ref.bytes, ref.width, ref.height].every((n) => Number.isSafeInteger(n) && n! > 0) &&
      (ref.name === undefined || typeof ref.name === 'string') &&
      (ref.originalDimensions === undefined ||
        (!!ref.originalDimensions &&
          typeof ref.originalDimensions === 'object' &&
          [ref.originalDimensions.width, ref.originalDimensions.height].every(
            (n) => Number.isSafeInteger(n) && n > 0,
          )))
    )
  })
}

function append(target: HarnessPromptPart[], parts: readonly HarnessPromptPart[]): void {
  for (const part of parts) {
    const last = target.at(-1)
    if (part.type === 'text' && last?.type === 'text') last.text += part.text
    else target.push(structuredClone(part))
  }
}
function joined(groups: readonly (readonly HarnessPromptPart[])[], separator: string) {
  const result: HarnessPromptPart[] = []
  for (const [index, group] of groups.entries()) {
    if (index) append(result, [{ type: 'text', text: separator }])
    append(result, group)
  }
  return result
}

/** Validate the complete text projection before replay or attachment reads. */
export function promptContentText(
  content: readonly HarnessPromptPart[],
  stage: HarnessInputStage,
  currentTextLength?: number,
): string {
  return requireHarnessInputText(
    content
      .map((part) => {
        if (part.type !== 'text') return '[图片附件]'
        if (typeof part.text !== 'string')
          throw harnessInputError(stage, 'type', {
            ...(currentTextLength === undefined ? {} : { currentTextLength }),
          })
        return part.text
      })
      .join(''),
    stage,
    currentTextLength === undefined ? {} : { currentTextLength },
  )
}

/** Keep the existing text transcript byte-for-byte; retain image positions for capable routes. */
export function conversationInput(
  messages: GenerateOptions['messages'],
  user: GenerateOptions['messages'][number],
  stage: 'conversation-first-binding' | 'conversation-followup' = 'conversation-first-binding',
): { text: string; content?: HarnessPromptPart[] } {
  const currentTextLength = currentHarnessInputText(user.content, 'conversation-current').length
  const history = messages
    .filter((message) => ['user', 'assistant', 'tool'].includes(message.role))
    .map((message) => {
      const blocks: HarnessPromptPart[][] = message.content.flatMap(
        (part): HarnessPromptPart[][] => {
          switch (part.type) {
            case 'text':
              if (typeof part.text !== 'string')
                throw harnessInputError(stage, 'type', { currentTextLength })
              return part.text ? [[{ type: 'text', text: part.text }]] : []
            case 'reasoning':
              return []
            case 'tool-call':
              return [
                [
                  {
                    type: 'text',
                    text: `历史工具调用 ${part.name} (${part.id}): ${part.arguments}`,
                  },
                ],
              ]
            case 'image':
              return [
                [
                  part.offloaded
                    ? { type: 'text', text: offloadedImageText(part.attachment) }
                    : { type: 'image', attachment: part.attachment },
                ],
              ]
            case 'file':
              throw new LlmError(
                '该 Harness 暂不支持直接文件附件，请提供项目内文件路径',
                'HARNESS_INPUT',
              )
            default:
              throw new LlmError(`该 Harness 暂不支持 ${part.type} 内容`, 'HARNESS_INPUT')
          }
        },
      )
      const parts = joined(blocks, '\n')
      if (!parts.length) return { message, parts }
      const role =
        message.role === 'tool'
          ? `tool (${message.toolCallId}${message.isError ? ', failed' : ''})`
          : message.role
      return { message, parts: joined([[{ type: 'text', text: `${role}: ` }], parts], '') }
    })
    .filter((item) => item.parts.length)
  const current = history.find((item) => item.message === user)?.parts ?? []
  const injected = history.filter(
    (item) => item.message.role === 'user' && item.message.source?.kind !== 'user',
  )
  const context = history.filter((item) => item.message !== user && !injected.includes(item))
  const transcript = context.length
    ? joined(
        [
          [{ type: 'text', text: HISTORY_NOTICE + '\n\n' }],
          joined(
            context.map((item) => item.parts),
            '\n\n',
          ),
          [{ type: 'text', text: '\n\n当前用户请求：\n' }],
          current,
        ],
        '',
      )
    : current
  const parts = injected.length
    ? joined(
        [
          [{ type: 'text', text: '会话上下文：\n' }],
          joined(
            injected.map((item) => item.parts),
            '\n\n',
          ),
          [{ type: 'text', text: '\n\n' }],
          context.length
            ? transcript
            : joined([[{ type: 'text', text: '当前用户请求：\n' }], current], ''),
        ],
        '',
      )
    : transcript
  const text = promptContentText(parts, stage, currentTextLength)
  return {
    text,
    ...(parts.some((part) => part.type === 'image') ? { content: parts } : {}),
  }
}

/** Resolve only immutable official attachments, and honor cancellation after every read. */
export async function resolvePromptContent(
  attachments: Pick<AttachmentStore, 'readImage'> | undefined,
  content: readonly HarnessPromptPart[],
  signal?: AbortSignal,
  stage: HarnessInputStage = 'stored-prompt',
): Promise<AcpPromptPart[]> {
  signal?.throwIfAborted()
  promptContentText(content, stage)
  const result: AcpPromptPart[] = []
  for (const part of content) {
    signal?.throwIfAborted()
    if (part.type === 'text') result.push({ ...part })
    else {
      if (!attachments) throw new LlmError('图片附件存储尚未就绪，未发送任务', 'HARNESS_INPUT')
      const stored = await attachments.readImage(part.attachment, signal)
      signal?.throwIfAborted()
      result.push({
        type: 'image',
        data: Buffer.from(stored.data).toString('base64'),
        mimeType: stored.ref.mediaType,
      })
    }
  }
  return result
}

/** Both the source and the connected official CLI must advertise images for this exact request. */
export function assertPromptImages(
  content: readonly { type: string }[],
  sourceEnabled: boolean | undefined,
  agent: Record<string, any> | undefined,
): void {
  if (!content.some((part) => part.type === 'image')) return
  if (sourceEnabled !== true)
    throw new LlmError('所选模型来源未声明支持图片，未发送任务', 'HARNESS_INPUT')
  if (agent?.agentCapabilities?.promptCapabilities?.image !== true)
    throw new LlmError('当前官方 Harness 未广告图片输入能力，未发送任务', 'HARNESS_INPUT')
}
