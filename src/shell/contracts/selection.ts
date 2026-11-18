/** Windows native DSH shell preference, owned by persisted Loader entries. */
export interface NativeShellStatus {
  available: boolean
  enabled: boolean
  pending?: boolean
  desired?: boolean
  reason?: string
}
