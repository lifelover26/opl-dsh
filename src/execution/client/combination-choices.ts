import { modelRefKey } from '../contracts/catalog.ts'
import type { CombinationDefinition, ExecutionCatalog } from '../contracts/catalog.ts'

type Pairing = Pick<CombinationDefinition, 'modelRef' | 'harnessRef'>

/** Visible choices and saved ids explicitly cleared by a bulk action. */
export interface CombinationSelection {
  selected: ReadonlySet<string>
  disabledIds: ReadonlySet<string>
}

/** Exact source/model and Harness identity for a suggested pairing. */
export const pairingKey = (item: Pairing): string =>
  JSON.stringify([modelRefKey(item.modelRef), item.harnessRef])

/** Saved configurations keep independent selection, including duplicate pairings. */
export const savedChoiceKey = (id: string): string => JSON.stringify(['saved', id])

/** New recommendations have a stable key before a configuration id exists. */
export const recommendationChoiceKey = (item: Pairing): string =>
  JSON.stringify(['recommended', pairingKey(item)])

/** Available saved configurations plus recommendations without a saved pairing. */
export function combinationChoices(catalog: ExecutionCatalog) {
  const available = new Set(
    catalog.models.filter((item) => item.available).map((item) => modelRefKey(item.ref)),
  )
  const existing = new Set(catalog.combinations.map(pairingKey))
  const recommendations = new Map(
    (catalog.recommendations ?? [])
      .filter((item) => !existing.has(pairingKey(item)))
      .map((item) => [pairingKey(item), item]),
  )
  return [
    ...catalog.combinations
      .filter((item) => available.has(modelRefKey(item.modelRef)))
      .map((item) => ({
        ...item,
        key: savedChoiceKey(item.id),
      })),
    ...[...recommendations.values()]
      .filter((item) => available.has(modelRefKey(item.modelRef)))
      .map((item) => ({
        ...item,
        key: recommendationChoiceKey(item),
        enabled: false,
      })),
  ]
}
