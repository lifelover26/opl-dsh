/** Agent-visible support for the current OPL host and its official MCP bridge. */
export interface McpAppHostStatus {
  /** OPL does not yet mount a standard MCP Apps renderer. Other plugins are independent. */
  oplPresentation: 'tools-only'
  officialBridge: {
    version: string | null
    assessment: 'known-public-api-gap' | 'unavailable-version' | 'unverified-version'
    missingPublicCapabilities: string[]
  }
  /** Current caller scope, never inferred from a tool-name prefix. */
  selectedTool: { name: string; available: boolean } | null
  resourceTools: string[]
  nextAction: 'call-owner-tool' | 'discover-owner-tool'
  guidance: string[]
}
