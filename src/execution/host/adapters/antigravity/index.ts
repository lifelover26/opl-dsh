/** Public adapter entry; program installation and Gateway routing retain their owners. */
export { antigravityAdapter } from './antigravity.ts'
export {
  ANTIGRAVITY_HARNESS,
  ANTIGRAVITY_GATEWAY_MODELS,
  ANTIGRAVITY_THINKING_LEVELS,
  ANTIGRAVITY_DEFAULT_THINKING,
  antigravityWireModel,
  antigravityThinking,
  isAntigravityGatewayModel,
} from './models.ts'
export { normalizeAntigravityUsage, antigravityContextUsage } from './usage.ts'
