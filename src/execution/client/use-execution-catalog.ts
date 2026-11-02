import { useEffect, useRef, useState } from 'react'
import type { TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import { modelRefKey } from '../contracts/catalog.ts'
import { pairingKey, savedChoiceKey, recommendationChoiceKey } from './combination-choices.ts'
import type { CombinationSelection } from './combination-choices.ts'
import { safeFailureMessage } from './proxy-draft.ts'
import type {
  ExecutionCatalog,
  CombinationDefinition,
  HarnessCatalog,
} from '../../contracts/types.ts'
import type { RemoteCallInput } from '../../shared/client/remote-call.ts'
/**
 * The catalog is one document, so a save is all-or-nothing. `blocked` is kept apart
 * from `failed`: a save that never ran because another one was in flight must not
 * be reported as the user having changed their settings.
 */
export type SaveResult =
  | { status: 'saved'; catalog: ExecutionCatalog }
  | { status: 'failed'; message: string }
  | { status: 'blocked' }
export function useExecutionCatalog(call: RemoteCallInput<TypertRemoteNamespace<'oplExecution'>>) {
  const [catalog, setCatalog] = useState<ExecutionCatalog>()
  const [availability, setAvailability] = useState<HarnessCatalog['combinations']>([])
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const [loadRevision, setLoadRevision] = useState(0)
  const [draft, setDraft] = useState({ model: '', harness: 'dsh' })
  const [editing, setEditing] = useState<string>()
  const running = useRef(false),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void (async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          const [next, combinations] = await Promise.all([
            call('catalog'),
            call('combinations', { includeDisabled: true }),
          ])
          if (!cancelled) {
            setCatalog(next)
            setAvailability(combinations)
            setNotice('')
          }
          return
        } catch {
          if (attempt === 2) {
            if (!cancelled) setNotice('无法读取组合目录')
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
          }
        }
      }
    })()
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [call, loadRevision])
  const persist = async (operation: () => Promise<ExecutionCatalog>): Promise<SaveResult> => {
    if (running.current) {
      if (mounted.current) setNotice('另一个配置正在保存，请稍后再试。')
      return { status: 'blocked' }
    }
    running.current = true
    setBusy(true)
    setNotice('')
    try {
      const saved = await operation()
      if (mounted.current) setCatalog(saved)
      try {
        const combinations = await call('combinations', { includeDisabled: true })
        if (mounted.current) {
          setAvailability(combinations)
          setNotice('已保存，新的选择使用此配置。')
        }
      } catch {
        if (mounted.current) setNotice('配置已保存；可用状态未刷新，请重新打开此页。')
      }
      return { status: 'saved', catalog: saved }
    } catch (cause) {
      const message = safeFailureMessage(cause)
      if (mounted.current) setNotice(message)
      return { status: 'failed', message }
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const save = (next: ExecutionCatalog) => persist(() => call('save-catalog', { catalog: next }))
  const update = (id: string, patch: Partial<CombinationDefinition>) => {
    if (!catalog) return
    const target = catalog.combinations.find((item) => item.id === id)
    if (!target) return
    void save({
      ...catalog,
      combinations: catalog.combinations.map((item) =>
        item.id === id
          ? {
              ...item,
              ...patch,
              generated: false,
              autoEnabled: false,
              autoEnabledDisabled: true,
            }
          : patch.isDefault && modelRefKey(item.modelRef) === modelRefKey(target.modelRef)
            ? { ...item, isDefault: false }
            : item,
      ),
    })
  }
  const add = async () => {
    if (!catalog) return
    const model = catalog.models.find((item) => modelRefKey(item.ref) === draft.model)
    if (!model) return
    if (
      !catalog.supportedPairings?.some(
        (item) =>
          modelRefKey(item.modelRef) === draft.model && item.harnessRefs.includes(draft.harness),
      )
    ) {
      setNotice('请先选择模型及已适配的 Harness。')
      return
    }
    const chosen = { modelRef: model.ref, harnessRef: draft.harness }
    if (
      [...catalog.combinations, ...(catalog.recommendations ?? [])].some(
        (item) => pairingKey(item) === pairingKey(chosen),
      )
    ) {
      setNotice('该组合已在选择列表中，请在上方勾选。')
      return
    }
    const result = await save({
      ...catalog,
      combinations: [
        ...catalog.combinations,
        {
          id: crypto.randomUUID(),
          name: `${model.name} + ${catalog.harnesses.find((item) => item.id === draft.harness)?.name ?? draft.harness}`,
          modelRef: model.ref,
          harnessRef: draft.harness,
          permissionPolicy: 'workspace',
          isDefault: false,
          enabled: true,
          autoEnabled: false,
          autoEnabledDisabled: true,
        },
      ],
    })
    if (result.status === 'saved' && mounted.current) setDraft({ model: '', harness: 'dsh' })
  }
  const addRecommendations = async ({ selected, disabledIds }: CombinationSelection) => {
    if (!catalog) return
    const existing = new Set(catalog.combinations.map(pairingKey))
    const additions: CombinationDefinition[] = []
    for (const item of catalog.recommendations ?? []) {
      const key = pairingKey(item)
      if (!selected.has(recommendationChoiceKey(item)) || existing.has(key)) continue
      existing.add(key)
      additions.push({
        ...item,
        id: crypto.randomUUID(),
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
        autoEnabled: false,
        autoEnabledDisabled: true,
      })
    }
    const availableModels = new Set(
      catalog.models.filter((model) => model.available).map((model) => modelRefKey(model.ref)),
    )
    const combinations = catalog.combinations.map((item) => {
      const available = availableModels.has(modelRefKey(item.modelRef))
      if (!available && !disabledIds.has(item.id)) return item
      const key = savedChoiceKey(item.id)
      const enabled = available && selected.has(key)
      return item.enabled !== enabled
        ? {
            ...item,
            enabled,
            generated: false,
            autoEnabled: false,
            autoEnabledDisabled: true,
          }
        : item
    })
    if (
      additions.length ||
      combinations.some((item, index) => item !== catalog.combinations[index])
    )
      await save({ ...catalog, combinations: [...combinations, ...additions] })
  }
  return {
    catalog,
    availability,
    busy,
    notice,
    retry: () => {
      setNotice('')
      setLoadRevision((value) => value + 1)
    },
    draft,
    setDraft,
    editing,
    setEditing,
    update,
    add,
    addRecommendations,
  }
}
