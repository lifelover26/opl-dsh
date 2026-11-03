import type { ModelRef, ModelDefinition } from '../../shared/models.ts'
import type { CodexGitBashRuntime } from './codex-runtime.ts'
export * from '../../shared/models.ts'
/** Network routing for this external CLI and its children; omission inherits Desktop. */
export type HarnessProxy =
  | { mode: 'inherit' }
  | { mode: 'direct' }
  | { mode: 'custom'; url: string }
export interface HarnessDefinition {
  id: string
  name: string
  kind: 'dsh' | 'grok-build' | 'acp'
  command?: string
  /** Arguments preceding the official CLI subcommand, such as its installed bundle path. */
  prefix?: string[]
  adapter?: string
  proxy?: HarnessProxy
  /** Optional suite-owned Windows build; omission uses the configured official CLI. */
  codexRuntime?: CodexGitBashRuntime
}
export interface CombinationDefinition {
  id: string
  name: string
  modelRef: ModelRef
  harnessRef: string
  generated?: boolean
  permissionPolicy: 'read-only' | 'workspace' | 'full-access'
  isDefault: boolean
  enabled: boolean
  /** Enabled state follows the model readiness until the user edits this combination. */
  autoEnabled?: boolean
  /** The user turned automatic readiness management off; readiness must not re-enable it. */
  autoEnabledDisabled?: boolean
}
export type OfmDiscoveryStatus =
  | { kind: 'official'; harness: string; label: string }
  | { kind: 'recommended'; harness: string; label: string }
  | { kind: 'manual'; harnesses: string[]; label: string }
  | { kind: 'excluded'; reason: string; label: string }
  | { kind: 'unknown'; label: string }

export interface OfmDiscoveryItem
  extends Pick<ModelDefinition, 'available' | 'reason' | 'unavailableKind'> {
  modelRef: ModelRef
  name: string
  status: OfmDiscoveryStatus
}
export interface ExecutionCatalog {
  version: 2
  models: ModelDefinition[]
  harnesses: HarnessDefinition[]
  combinations: CombinationDefinition[]
  /** Available, explicitly adapted channel pairings offered for manual addition. */
  recommendations?: Array<{ modelRef: ModelRef; harnessRef: string; name: string }>
  /** Live adapter compatibility for the manual pairing form; not a readiness verdict. */
  supportedPairings?: Array<{ modelRef: ModelRef; harnessRefs: string[] }>
  /** Current OFM directory entries; saved combination references alone are excluded. */
  ofmDiscovery?: OfmDiscoveryItem[]
}
