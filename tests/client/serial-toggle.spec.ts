import { describe, expect, it, vi } from 'vitest'
import { createSerialToggle } from '../../src/shared/client/serial-toggle.ts'

describe('serial optional plugin toggle', () => {
  it('cancels queued starts when the settings owner unloads', async () => {
    const start = vi.fn(() => ({}))
    const stop = vi.fn(async () => {})
    const toggle = createSerialToggle({ start, stop })
    const pending = toggle.set(true)
    await toggle.dispose()
    await pending
    await toggle.set(true)
    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('waits for unload before starting again', async () => {
    const events: string[] = []
    let release!: () => void
    const toggle = createSerialToggle({
      start: () => {
        events.push('start')
        return {}
      },
      stop: vi.fn(async () => {
        events.push('stop-begin')
        await new Promise<void>((resolve) => {
          release = resolve
        })
        events.push('stop-end')
      }),
    })
    await toggle.set(true)
    const stopping = toggle.set(false)
    const restarting = toggle.set(true)
    await Promise.resolve()
    expect(events).toEqual(['start', 'stop-begin'])
    release()
    await Promise.all([stopping, restarting])
    expect(events).toEqual(['start', 'stop-begin', 'stop-end', 'start'])
  })
})
