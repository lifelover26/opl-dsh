import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Durable external input references; encoded image bytes belong only to the request wire. */
export type HarnessPromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }
