/** Account groups are credential scopes. Protocol and model configuration live in DSH settings. */
export const GATEWAY_GROUPS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    aliases: [],
    keyLabel: 'DeepSeek',
    credential: 'OPL_GATEWAY_DEEPSEEK_API_KEY',
    provider: 'opl-gateway',
    api: 'messages',
  },
  {
    id: 'codex',
    name: 'OpenAI 协议',
    /** The Gateway still calls this credential scope Codex on older accounts. */
    aliases: ['Codex', 'OpenAI Protocol'],
    keyLabel: 'Codex',
    credential: 'OPL_GATEWAY_CODEX_API_KEY',
    provider: 'opl-gateway-openai',
    api: 'openai-responses',
  },
  {
    id: 'grok',
    name: 'Grok',
    aliases: [],
    keyLabel: 'Grok',
    credential: 'OPL_GATEWAY_GROK_API_KEY',
    provider: 'opl-gateway-grok',
    api: 'openai-responses',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    aliases: [],
    keyLabel: 'Gemini',
    credential: 'OPL_GATEWAY_GEMINI_API_KEY',
    provider: 'opl-gateway-gemini',
    api: 'openai-completions',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    aliases: [],
    keyLabel: 'Kiro',
    credential: 'OPL_GATEWAY_KIRO_API_KEY',
    provider: 'opl-gateway-kiro',
    api: 'anthropic-messages',
  },
  {
    id: 'aws',
    name: 'AWS',
    aliases: [],
    keyLabel: 'AWS',
    credential: 'OPL_GATEWAY_AWS_API_KEY',
    provider: 'opl-gateway-aws',
    api: 'anthropic-messages',
  },
  {
    id: 'claude',
    name: 'Claude',
    aliases: [],
    keyLabel: 'Claude',
    credential: 'OPL_GATEWAY_CLAUDE_API_KEY',
    provider: 'opl-gateway-claude',
    api: 'anthropic-messages',
  },
] as const
export type GatewayGroupId = (typeof GATEWAY_GROUPS)[number]['id']
export type GatewayGroupName = (typeof GATEWAY_GROUPS)[number]['name']
export const internalGatewayProvider = (id: string) =>
  id === 'opl-gateway-auto-review' ||
  GATEWAY_GROUPS.some((group) => group.id !== 'deepseek' && group.provider === id)
