/** Validate external input without changing text or including its contents in errors. */
import { LlmError } from '@deepseek-ai/dsh-llm'

export const HARNESS_INPUT_MAX_LENGTH = 200_000

export type HarnessInputStage =
  | 'request'
  | 'conversation-current'
  | 'conversation-first-binding'
  | 'conversation-followup'
  | 'conversation-replay'
  | 'stored-prompt'
  | 'edit-request'

const inputLabels: Record<HarnessInputStage, string> = {
  request: '当前输入',
  'conversation-current': '当前用户输入',
  'conversation-first-binding': '首次绑定时拼接的会话输入',
  'conversation-followup': '本轮会话输入',
  'conversation-replay': '已保存的会话输入',
  'stored-prompt': '已保存的输入',
  'edit-request': '编辑后的输入',
}

/** Build a typed refusal with fixed diagnostic keys and observed lengths only. */
export function harnessInputError(
  stage: HarnessInputStage,
  reason: 'type' | 'blank' | 'too-long',
  lengths: { currentTextLength?: number; promptTextLength?: number } = {},
): LlmError {
  const detail =
    reason === 'type'
      ? '必须是文本'
      : reason === 'blank'
        ? '为空'
        : `超过 ${HARNESS_INPUT_MAX_LENGTH} 字符限制`
  const diagnostics = [
    `stage=${stage}`,
    `reason=${reason}`,
    ...(lengths.currentTextLength === undefined
      ? []
      : [`currentTextLength=${lengths.currentTextLength}`]),
    ...(lengths.promptTextLength === undefined
      ? []
      : [`promptTextLength=${lengths.promptTextLength}`]),
    `maxTextLength=${HARNESS_INPUT_MAX_LENGTH}`,
  ].join('; ')
  return new LlmError(
    `${inputLabels[stage]}${detail}，本轮未发送（${diagnostics}）。`,
    'HARNESS_INPUT',
  )
}

/** Return unchanged text; lengths use the same UTF-16 units as the admission limit. */
export function requireHarnessInputText(
  value: unknown,
  stage: HarnessInputStage,
  options: { currentTextLength?: number; allowBlank?: boolean } = {},
): string {
  const length = typeof value === 'string' ? value.length : undefined
  const currentTextLength =
    options.currentTextLength ??
    (['request', 'conversation-current', 'edit-request'].includes(stage) ? length : undefined)
  const lengths = {
    ...(currentTextLength === undefined ? {} : { currentTextLength }),
    ...(length === undefined ? {} : { promptTextLength: length }),
  }
  if (typeof value !== 'string') throw harnessInputError(stage, 'type', lengths)
  if (!options.allowBlank && !value.trim()) throw harnessInputError(stage, 'blank', lengths)
  if (value.length > HARNESS_INPUT_MAX_LENGTH) throw harnessInputError(stage, 'too-long', lengths)
  return value
}

/** Check current text before role labels or history can hide an empty or malformed request. */
export function currentHarnessInputText(
  content: readonly { type: string; text?: unknown }[],
  stage: 'conversation-current' | 'edit-request',
): string {
  if (!Array.isArray(content)) throw harnessInputError(stage, 'type')
  const texts: string[] = []
  let image = false
  for (const part of content) {
    if (!part || typeof part !== 'object') throw harnessInputError(stage, 'type')
    switch (part.type) {
      case 'text':
        if (typeof part.text !== 'string') throw harnessInputError(stage, 'type')
        texts.push(part.text)
        break
      case 'image':
        image = true
        break
      case 'file':
        throw new LlmError('该 Harness 暂不支持直接文件附件，请提供项目内文件路径', 'HARNESS_INPUT')
      default:
        throw harnessInputError(stage, 'type')
    }
  }
  return requireHarnessInputText(texts.join('\n'), stage, { allowBlank: image })
}
