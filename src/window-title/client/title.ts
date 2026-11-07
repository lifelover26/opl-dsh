export const FIXED_WINDOW_TITLE = 'DeepSeek Harness'

/**
 * Keep the renderer document title stable while the preference is enabled.
 * The official renderer may rewrite `<title>` when a Session changes, so the observer
 * restores the fixed value. Disabling the preference restores the title seen before it.
 */
export function installFixedWindowTitle(
  documentLike: Document,
  enabled: boolean,
): { setEnabled(next: boolean): void; dispose(): void } {
  let active = enabled
  let previousTitle = documentLike.title
  let disposed = false
  const observer =
    typeof MutationObserver === 'function' && documentLike.head
      ? new MutationObserver(() => {
          if (active && !disposed && documentLike.title !== FIXED_WINDOW_TITLE)
            documentLike.title = FIXED_WINDOW_TITLE
        })
      : undefined
  const observe = () => {
    if (!observer || !documentLike.head) return
    observer.observe(documentLike.head, { childList: true, characterData: true, subtree: true })
  }
  const enforce = () => {
    if (active && documentLike.title !== FIXED_WINDOW_TITLE) documentLike.title = FIXED_WINDOW_TITLE
  }
  if (active) {
    enforce()
    observe()
  }
  return {
    setEnabled(next) {
      if (disposed || next === active) return
      if (next) {
        previousTitle = documentLike.title
        active = true
        enforce()
        observe()
      } else {
        active = false
        observer?.disconnect()
        documentLike.title = previousTitle
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      if (active) documentLike.title = previousTitle
    },
  }
}
