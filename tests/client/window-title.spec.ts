import { afterEach, expect, it, vi } from 'vitest'
import { FIXED_WINDOW_TITLE, installFixedWindowTitle } from '../../src/window-title/client/title.ts'

afterEach(() => vi.unstubAllGlobals())

it('keeps the renderer title fixed and restores the prior title when disabled', () => {
  vi.stubGlobal('MutationObserver', undefined)
  const documentLike = { title: 'A conversation', head: {} } as unknown as Document
  const title = installFixedWindowTitle(documentLike, true)

  expect(documentLike.title).toBe(FIXED_WINDOW_TITLE)
  title.setEnabled(false)
  expect(documentLike.title).toBe('A conversation')
  title.setEnabled(true)
  expect(documentLike.title).toBe(FIXED_WINDOW_TITLE)
  title.dispose()
  expect(documentLike.title).toBe('A conversation')
})
