/** Serialize optional plugin activation so unload completes before reactivation. */
export function createSerialToggle<T>(options: {
  start: () => T
  stop: (value: T) => PromiseLike<unknown> | unknown
}): {
  set(enabled: boolean): Promise<void>
  dispose(): Promise<void>
} {
  let current: T | undefined
  let disposed = false
  let queue = Promise.resolve()
  const reconcile = async (desired: boolean) => {
    desired = desired && !disposed
    if (desired === (current !== undefined)) return
    if (current !== undefined) {
      const value = current
      current = undefined
      await options.stop(value)
    }
    if (desired && !disposed) current = options.start()
  }
  return {
    set(enabled) {
      if (disposed) return queue
      queue = queue.then(() => reconcile(enabled))
      return queue
    },
    dispose() {
      disposed = true
      queue = queue.then(() => reconcile(false))
      return queue
    },
  }
}
