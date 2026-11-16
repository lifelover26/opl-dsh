const PROXY_HINT_MARKER = '原生 DSH '

/** Split a model-listing diagnostic into its core reason and optional shared proxy guidance. */
export function splitProxyHint(message: string): { core: string; hint?: string } {
  const trimmed = message.trim()
  const index = trimmed.lastIndexOf(PROXY_HINT_MARKER)
  if (index <= 0) return { core: trimmed }
  const core = trimmed.slice(0, index).trim()
  const hint = trimmed.slice(index).trim()
  if (!core || !hint.includes('.env')) return { core: trimmed }
  return { core, hint }
}

/** Format one or more group discovery failures without repeating shared proxy instructions or colliding punctuation. */
export function summarizeDiscoveryErrors(
  messages: readonly string[],
  suffix?: string,
): { items: string[]; hints: string[]; suffix?: string } {
  const items: string[] = []
  const hints: string[] = []
  const seenHints = new Set<string>()
  for (const raw of messages) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const { core, hint } = splitProxyHint(trimmed)
    items.push(core)
    if (hint && !seenHints.has(hint)) {
      seenHints.add(hint)
      hints.push(hint)
    }
  }
  return {
    items,
    hints,
    ...(suffix ? { suffix } : {}),
  }
}
