/** Closed-step counts for the current conversation history. */
export interface ConversationCounts {
  /** Distinct turns with at least one retained `step/end` event. */
  readonly turns: number
  /** Retained `step/end` events, including failed and cancelled steps. */
  readonly steps: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole-log counts after admitted OPL message edits remove their replaced ranges. */
    oplConversationCounts: ConversationCounts
  }
}
