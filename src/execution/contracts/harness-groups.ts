/**
 * User-facing order for the Harness directory. This is information
 * architecture, not adapter capability: every listed Harness stays fully
 * manageable, while the settings page keeps the common choices visible and
 * moves specialised engines behind one disclosure.
 */
export const PRIMARY_HARNESS_IDS = [
  'dsh',
  'codex',
  'claude',
  'grok-build',
  'antigravity',
  'opencode',
] as const

export const PRIMARY_HARNESS_ORDER = new Map<string, number>(
  PRIMARY_HARNESS_IDS.map((id, index) => [id, index]),
)

export function isPrimaryHarness(id: string): boolean {
  return PRIMARY_HARNESS_ORDER.has(id)
}

/** Built-in and common engines first; remaining adapted engines retain catalog order. */
export function harnessDirectoryOrder(left: string, right: string): number {
  return (
    (PRIMARY_HARNESS_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (PRIMARY_HARNESS_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER)
  )
}
