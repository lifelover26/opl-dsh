import { unavailableModelLabel, type ModelDefinition } from '../contracts/catalog.ts'
import css from './CombinationRows.module.css'

/** Source and combination rows share compact labels and keep reasons on hover. */
export function ModelAvailabilityStatus({
  available,
  reason,
  unavailableKind,
}: Pick<ModelDefinition, 'available' | 'reason' | 'unavailableKind'>) {
  if (available) return null
  const label = unavailableModelLabel(unavailableKind)
  return (
    <span
      className={css.failure}
      title={reason ?? label}
      data-opl-model-availability={unavailableKind ?? 'unavailable'}
    >
      {label}
    </span>
  )
}
