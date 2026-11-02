import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { displayModelSource } from '../contracts/catalog.ts'
import type { ExecutionCatalog } from '../contracts/catalog.ts'
import css from './RecommendationPicker.module.css'
import { combinationChoices, savedChoiceKey } from './combination-choices.ts'
import type { CombinationSelection } from './combination-choices.ts'

/** One selection surface controls saved configurations and new recommendations. */
export function RecommendationPicker({
  catalog,
  busy,
  onAdd,
}: {
  catalog: ExecutionCatalog
  busy: boolean
  onAdd: (selection: CombinationSelection) => Promise<void>
}) {
  const candidates = combinationChoices(catalog).map((item) => [item.key, item] as const)
  const enabled = () => new Set(candidates.filter(([, item]) => item.enabled).map(([key]) => key))
  const [selected, setSelected] = useState<Set<string>>(enabled)
  const [disabledIds, setDisabledIds] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    setSelected(enabled())
    setDisabledIds(new Set())
  }, [catalog])
  const groups = [...new Set(candidates.map(([, item]) => item.harnessRef))]
  const count = candidates.filter(([key]) => selected.has(key)).length
  const visibleIds = new Set(candidates.map(([, item]) => item.key))
  const hiddenEnabled = catalog.combinations.some(
    (item) => item.enabled && !visibleIds.has(savedChoiceKey(item.id)) && !disabledIds.has(item.id),
  )
  const toggle = (keys: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const key of keys) checked ? next.add(key) : next.delete(key)
      return next
    })
  const clearSaved = (harness?: string) =>
    setDisabledIds(
      (current) =>
        new Set([
          ...current,
          ...catalog.combinations
            .filter((item) => harness === undefined || item.harnessRef === harness)
            .map((item) => item.id),
        ]),
    )
  if (!candidates.length && !catalog.combinations.some((item) => item.enabled)) return null
  return (
    <div className={css.picker}>
      <div className={css.toolbar}>
        <strong>选择要启用的组合</strong>
        <Button
          disabled={busy || !candidates.length}
          onClick={() =>
            toggle(
              candidates.map(([key]) => key),
              true,
            )
          }
        >
          全选
        </Button>
        <Button
          disabled={busy || (!count && !hiddenEnabled)}
          onClick={() => {
            setSelected(new Set())
            clearSaved()
          }}
        >
          取消全选
        </Button>
      </div>
      <div className={css.groups}>
        {groups.map((harness) => {
          const items = candidates.filter(([, item]) => item.harnessRef === harness)
          const checked = items.filter(([key]) => selected.has(key)).length
          const name = catalog.harnesses.find((item) => item.id === harness)?.name ?? harness
          return (
            <div className={css.group} key={harness}>
              <label className={css.groupLabel}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={checked === items.length}
                  ref={(node) => {
                    if (node) node.indeterminate = checked > 0 && checked < items.length
                  }}
                  data-opl-recommendation-group={harness}
                  onChange={(event) => {
                    toggle(
                      items.map(([key]) => key),
                      event.target.checked,
                    )
                    if (!event.target.checked) clearSaved(harness)
                  }}
                />
                {name}（{checked}/{items.length}）
              </label>
              {items.map(([key, item]) => (
                <label className={css.item} key={key}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.has(key)}
                    data-opl-recommendation-item={key}
                    onChange={(event) => toggle([key], event.target.checked)}
                  />
                  <span>
                    {displayModelSource(item.modelRef)} · {item.name}
                  </span>
                </label>
              ))}
            </div>
          )
        })}
      </div>
      <Button
        disabled={busy}
        onClick={() =>
          void onAdd({
            selected: new Set(candidates.filter(([key]) => selected.has(key)).map(([key]) => key)),
            disabledIds: new Set(disabledIds),
          })
        }
      >
        保存选择（{count}）
      </Button>
    </div>
  )
}
