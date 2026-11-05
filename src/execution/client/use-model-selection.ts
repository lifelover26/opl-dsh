/**
 * Keep the OPL model projection live.
 *
 * The official Host computes one durable `modelSelection` projection per
 * Session and pushes every finished value through the Session control stream.
 * That projection is exactly the "next request" intent: `next` is the selection
 * the following request uses, while `lastUsed` is what an already-recorded
 * request consumed. The OPL menu owns only the combination binding around that
 * official selection, so it must read the pushed projection instead of a
 * one-shot RPC — otherwise an external writer (an official CLI harness, the
 * Codex helper) changes the model while the composer keeps showing the value
 * it read when it mounted.
 *
 * The RPC stays as the fallback: it resolves the OPL combination bound to the
 * official selection, and it answers before the first projection frame reaches
 * a freshly opened Session.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-agent/types'

/** One finished official model-selection projection; `next` already falls back to `lastUsed`. */
export type ModelSelectionSnapshot = {
  readonly getSnapshot: () => ModelSelectionProjection | undefined
  readonly subscribe: (listener: () => void) => () => void
}
/** Resolve the current Session's official selection projection face. */
export type SelectionSource = (sessionId: string) => ModelSelectionSnapshot | undefined
/** The next official selection of one Session, as published by RPC or by the projection. */
export type SelectionState = {
  current: ModelSelection | null
  groups: ModelCatalog['groups']
  combination?: string
  effortSource?: 'harness'
}
/** One Session read result: the official selection plus everything displayed around it. */
export type SelectionRead = SelectionState
/** State shown before any read or frame answers. */
export const NO_SELECTION: SelectionState = { current: null, groups: [] }

function projectionSelection(value: unknown): ModelSelection | undefined {
  if (value === null || value === undefined) return undefined
  const projection = value as ModelSelectionProjection
  return projection.next ?? projection.lastUsed ?? undefined
}

/**
 * Outward selection state for one Session, reactive to the official projection.
 *
 * A pushed selection is authoritative. An empty new-Session projection leaves
 * the effective default to the RPC result. A read that resolves
 * after the Session changed — or after a newer projection arrived — is
 * discarded instead of overwriting the current view.
 */
export class ModelSelectionState {
  private value: SelectionState = NO_SELECTION
  private generation = 0
  private sessionId: string | undefined
  private source: ModelSelectionSnapshot | undefined
  private readonly listeners = new Set<() => void>()

  /**
   * @param load - RPC read of one Session's selection plus its display catalogue.
   */
  constructor(private readonly load: (sessionId: string) => Promise<SelectionRead>) {}
  /** Snapshot read for the React external store. */
  getSnapshot = (): SelectionState => this.value
  /** Subscribe to outward state changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /**
   * Rebinding to the addressed Session invalidates in-flight reads.
   * @param sessionId - addressed Session, or undefined once the component releases it.
   * @param source - reader of that Session's pushed selection projection.
   */
  reset(sessionId: string | undefined, source: ModelSelectionSnapshot | undefined): void {
    this.generation += 1
    this.sessionId = sessionId
    this.source = source
    this.value = NO_SELECTION
  }
  /**
   * Read the pushed official selection.
   * @returns the projected next selection with the known combination, or undefined while no frame has landed.
   */
  projected(): SelectionState | undefined {
    const selection = projectionSelection(this.source?.getSnapshot())
    if (selection === undefined) return undefined
    const sameModel =
      selection?.provider === this.value.current?.provider &&
      selection?.model === this.value.current?.model
    const combination = sameModel ? this.value.combination : undefined
    const effortSource = sameModel ? this.value.effortSource : undefined
    const { reasoningEffort: _nativeEffort, ...ref } = selection
    const current =
      effortSource === 'harness'
        ? {
            ...ref,
            ...(this.value.current?.reasoningEffort
              ? { reasoningEffort: this.value.current.reasoningEffort }
              : {}),
          }
        : selection
    return {
      current,
      groups: this.value.groups,
      ...(combination === undefined ? {} : { combination }),
      ...(effortSource ? { effortSource } : {}),
    }
  }
  /**
   * Refresh from the OPL RPC, ignoring a superseded answer.
   * @param sessionId - Session the read addresses.
   */
  async refresh(sessionId: string): Promise<void> {
    const generation = (this.generation += 1)
    const next = await this.load(sessionId)
    if (generation !== this.generation || sessionId !== this.sessionId) return
    this.publish(next)
  }
  /** Replace the published state, notifying subscribers. */
  set(next: SelectionState): void {
    this.publish(next)
  }
  private publish(next: SelectionState): void {
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Subscribe the OPL model projection to the official per-Session selection.
 * @param options - addressed Session, mount gate, optional projection resolver, and RPC fallback.
 * @returns the live selection state and the state owner exposing it.
 */
export function useModelSelection(options: {
  sessionId: string
  available: boolean
  selectionSource?: SelectionSource | undefined
  load: (sessionId: string) => Promise<SelectionRead>
  onError: (message: string) => void
}): {
  selection: SelectionState
  store: ModelSelectionState
  reload: (sessionId: string) => Promise<void>
} {
  const { sessionId, available } = options
  const latest = useRef(options)
  latest.current = options
  const store = useMemo(() => new ModelSelectionState((id) => latest.current.load(id)), [sessionId])
  const [, setRevision] = useState(0)
  useEffect(() => {
    if (!available) return
    let mounted = true
    const face = latest.current.selectionSource?.(sessionId)
    store.reset(sessionId, face)
    const offStore = store.subscribe(() => setRevision((revision) => revision + 1))
    const modelKey = () => {
      const selected = projectionSelection(face?.getSnapshot())
      return selected ? JSON.stringify([selected.provider, selected.model]) : undefined
    }
    let lastModel = modelKey()
    const off = face?.subscribe(() => {
      setRevision((revision) => revision + 1)
      const nextModel = modelKey()
      if (nextModel === lastModel) return
      lastModel = nextModel
      void store.refresh(sessionId).catch((cause: unknown) => {
        if (mounted) latest.current.onError(cause instanceof Error ? cause.message : '无法读取组合')
      })
    })
    setRevision((revision) => revision + 1)
    void store.refresh(sessionId).catch((cause: unknown) => {
      if (!mounted) return
      latest.current.onError(cause instanceof Error ? cause.message : '无法读取组合')
    })
    return () => {
      mounted = false
      off?.()
      offStore()
      store.reset(undefined, undefined)
    }
  }, [available, sessionId, store])
  const reload = async (id: string): Promise<void> => {
    try {
      await store.refresh(id)
    } catch (cause) {
      if (latest.current.sessionId !== id) return
      latest.current.onError(cause instanceof Error ? cause.message : '无法读取组合')
    }
  }
  return { selection: store.projected() ?? store.getSnapshot(), store, reload }
}
