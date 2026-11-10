/** Adapter support, not proof that a particular installed CLI version works. */
export interface HarnessCapabilities {
  transport: 'dsh' | 'acp' | 'app-server' | 'official-sdk'
  authentication: 'dsh-provider' | 'api-source' | 'official-account'
  protocols: ('responses' | 'messages' | 'chat' | 'gemini-native')[]
  customEndpoint: boolean
  permissions: ('read-only' | 'workspace' | 'full-access')[]
  sessionLoad: boolean
  cancel: boolean
  reasoning: 'model-declared' | 'cli-advertised' | 'none'
  autoReview: 'codex-auto-review' | 'official' | 'unsupported'
}
