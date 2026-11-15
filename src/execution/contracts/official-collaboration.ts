/** Official member tools exposed to one external execution through its scoped capability. */
export interface ExternalOfficialTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
export interface OfficialCollaborationPort {
  instructions(sessionId: string, signal: AbortSignal): Promise<string>
  tools(sessionId: string, signal: AbortSignal): Promise<ExternalOfficialTool[]>
  call(
    sessionId: string,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<{ content: unknown[]; isError: boolean }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplOfficialCollaboration: OfficialCollaborationPort
  }
}
