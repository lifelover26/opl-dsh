import type { HarnessDefinition } from './catalog.ts'
import type { HarnessCapabilities } from './capabilities.ts'

export interface HarnessInstallation {
  id: string
  name: string
  /** The same persisted Harness shown by detection; no model catalog is needed. */
  definition?: HarnessDefinition
  capabilities?: HarnessCapabilities
  installed: boolean
  /** File presence and a successful version probe are distinct; ZCode is deliberately not probed. */
  verification?: 'verified' | 'failed' | 'not-probed'
  version?: string
  path?: string
  /** Where the host found the executable; useful when the desktop PATH differs from a shell. */
  detectedBy?: 'configured-path' | 'shell-path' | 'known-path' | 'app-bundle'
  /** Other launcher files found without starting additional version processes. */
  discovery?: {
    otherPaths: string[]
    /** The bounded Codex desktop directory search did not inspect every entry. */
    limited?: boolean
  }
  error?: string
  /** An independently found official entry; detection never replaces a configured path with it. */
  installedCandidate?: {
    path: string
    version?: string
    verification: 'verified' | 'failed' | 'not-probed'
    error?: string
  }
  runnable: boolean
  instructions: string
  website: string
  installable?: boolean
  maintenanceAction?: 'install' | 'update'
  maintenance?: {
    state: 'running' | 'completed' | 'failed'
    message: string
    startedAt: string
    finishedAt?: string
  }
}
