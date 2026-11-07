/** Browser dependencies supplied by the suite's generated RPC adapter. */
import type { OplUpdateApi } from '../contracts.ts'

/** A missing connection generation disables writes and invalidates pending responses. */
export interface UpdateConnectionSource {
  getSnapshot(): number | undefined
  subscribe(listener: () => void): () => void
}

/** The Host owns discovery, preferences, downloads, and prepared updates. */
export interface Config {
  api: OplUpdateApi
  connection?: UpdateConnectionSource
  /** Observe Host status changes; the Client reads status without scheduling discovery. */
  subscribe?: (listener: () => void) => () => void
  /** Open the existing General settings section when supplied by its navigation owner. */
  openSettings?: () => void
}
