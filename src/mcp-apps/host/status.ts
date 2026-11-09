/** Read the actual official bridge version without opening an MCP connection. */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import type { McpAppHostStatus } from '../contracts/status.ts'

const require = createRequire(import.meta.url)
const resourceTools = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
const assessedVersion = '0.2.2-rc.1'

export function officialMcpBridgeVersion(): string | null {
  try {
    const path = require.resolve('@deepseek-ai/dsh-mcp-client/package.json')
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      value &&
      typeof value === 'object' &&
      'version' in value &&
      typeof value.version === 'string'
    )
      return value.version
  } catch {
    // The optional package may be absent or unreadable; neither proves profile installation state.
  }
  return null
}

/** Resolve availability through the caller's live official ToolRuntime scope. */
export function inspectMcpAppHost(
  hasTool: (name: string) => boolean,
  toolName?: string,
  version = officialMcpBridgeVersion(),
): McpAppHostStatus {
  const available = toolName !== undefined && hasTool(toolName)
  return {
    oplPresentation: 'tools-only',
    officialBridge: {
      version,
      assessment:
        version === null
          ? 'unavailable-version'
          : version === assessedVersion
            ? 'known-public-api-gap'
            : 'unverified-version',
      missingPublicCapabilities:
        version === assessedVersion
          ? [
              'MCP Apps capability negotiation on the existing connection',
              'Server-owned tool UI metadata and app visibility on the public tool definition',
              'Session-bound app resource and tool dispatch through the same connection',
            ]
          : [],
    },
    selectedTool: toolName === undefined ? null : { name: toolName, available },
    resourceTools: resourceTools.filter(hasTool),
    nextAction: available ? 'call-owner-tool' : 'discover-owner-tool',
    guidance: [
      'Use the current owner tool and its structured result; the official scope and approval chain still apply.',
      'When a result provides its own browser or professional-app handoff, present that exact reference to the user. Do not invent a URL or open it automatically.',
      'To reopen or reconcile an unknown mutation, use the owner readback operation and original object/revision. Never repeat the mutation just to display its result.',
      'This describes OPL presentation only; another installed UI plugin must establish its own live capability and authorization evidence.',
    ],
  }
}
