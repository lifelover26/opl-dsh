/** Feed the official composer meter from the selected CLI's context observation. */
import { createElement, useEffect, useMemo, useState, type ComponentType } from 'react'
import type { ComposerBarProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { MaybeSnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { SessionSnapshot, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { officialHarnessFor } from '../contracts/official-harnesses.ts'
import type { HarnessContextReading } from '../contracts/usage.ts'

/** Dependencies for the resident official composer's external context reading. */
export interface HarnessContextMeterOptions {
  entries: () => readonly StoredEntry[]
  subscribe: (listener: () => void) => () => void
  contextUsage: (sessionId: string) => Promise<HarnessContextReading | null>
  sessionChanges: (sessionId: string, listener: () => void) => () => void
}

interface Reading {
  route: string
  value: HarnessContextReading | null
}

interface Pressure {
  pressureTokens: number
  projectedTokens: number
  contextWindow: number
}

// ui-session supplies this standard kit at runtime; it is not a direct development dependency.
type ResidentComposerProps = ComposerBarProps & {
  sessionId: string
  useProjection: UseProjection
  useSession: MaybeSnapshotSelectorHook<SessionSnapshot>
}

/**
 * Decorate the existing bar's projection reader while retaining its editor and meter.
 * Official Vibe, StepCode, and MiniMax routes replace native pressure.
 * @param options - Public slot inspection, context RPC, and Session lifecycle subscriptions.
 * @returns Disposer restoring the component owned by the official registration.
 */
export function installHarnessContextMeter(options: HarnessContextMeterOptions): () => void {
  let current: StoredEntry | undefined
  let restore = () => {}
  const reconcile = () => {
    const entry = options.entries()[0]
    if (entry === current) return
    restore()
    current = entry
    if (!entry) return
    const original = entry.component
    // Slot inspection erases the component type; this slot publishes ComposerBarProps.
    const component = original as ComponentType<ComposerBarProps>
    const resident = (props: ResidentComposerProps) => {
      const selection = props.useProjection('modelSelection')
      const selected = selection?.next ?? selection?.lastUsed
      const harness = selected ? officialHarnessFor(selected) : undefined
      const external = harness === 'vibe' || harness === 'step-code' || harness === 'minimax-code'
      const sessionId = props.sessionId
      const running = props.useSession((session) => session?.running === true)
      const route =
        external && sessionId && selected
          ? JSON.stringify([sessionId, harness, selected.provider, selected.model])
          : undefined
      const [reading, setReading] = useState<Reading | undefined>()

      useEffect(() => {
        let released = false
        let generation = 0
        setReading(undefined)
        if (!route || !sessionId || !selected) return
        const refresh = () => {
          if (released) return
          const request = ++generation
          setReading(undefined)
          if (running) return
          void options.contextUsage(sessionId).then(
            (value) => {
              if (released || request !== generation) return
              const matching =
                value !== null &&
                value.harness === harness &&
                value.provider === selected.provider &&
                value.model === selected.model
              setReading({ route, value: matching ? value : null })
            },
            () => {
              if (!released && request === generation) setReading({ route, value: null })
            },
          )
        }
        const off = options.sessionChanges(sessionId, refresh)
        refresh()
        return () => {
          released = true
          generation += 1
          off()
        }
      }, [route, running, sessionId])

      const observed =
        !running && reading?.route === route ? reading?.value?.contextUsage : undefined
      const pressure = useMemo<Pressure | undefined>(() => {
        if (observed?.used === undefined || observed.size === undefined) return undefined
        return {
          pressureTokens: observed.used,
          projectedTokens: observed.used,
          contextWindow: observed.size,
        }
      }, [observed])
      const useProjection = useMemo(() => {
        // Optional projection keys are contributed by the Host's token-meter plugin.
        const read = props.useProjection as (key: string, ...args: unknown[]) => unknown
        return ((key: string, ...args: unknown[]) => {
          if (!external || (key !== 'contextPressure' && key !== 'contextBreakdown'))
            return read(key, ...args)
          const value = key === 'contextPressure' ? pressure : undefined
          const selector = args[0]
          // Retain the official Hook's subscription and selector/equality semantics.
          return read(
            key,
            () => (typeof selector === 'function' ? selector(value) : value),
            args[1],
          )
        }) as UseProjection
      }, [props.useProjection, external, pressure])

      const composerProps = external ? { ...props, useProjection } : props
      return createElement(component, composerProps)
    }
    const decorated = (props: ComposerBarProps) => {
      if (
        !('sessionId' in props) ||
        typeof props.sessionId !== 'string' ||
        !('useProjection' in props) ||
        typeof props.useProjection !== 'function' ||
        !('useSession' in props) ||
        typeof props.useSession !== 'function'
      )
        return createElement(component, props)
      return createElement(resident, props as ResidentComposerProps)
    }
    entry.component = decorated
    restore = () => {
      if (entry.component === decorated) entry.component = original
    }
  }
  const off = options.subscribe(reconcile)
  reconcile()
  return () => {
    off()
    restore()
  }
}
