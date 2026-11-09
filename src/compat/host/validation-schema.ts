/** Bridge the official parse-only storage/projection boundary across Zod minor versions. */
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

interface ValidationSchema<T> {
  parse(input: unknown): T
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown }
}

/**
 * Official DSH 0.2.2-rc.1 declares its private Zod 4.4.3 identity here, but its
 * projection and storage-domain consumers use only parse/safeParse. Keep that
 * declaration adaptation at this boundary: the real parser remains the OPL
 * plugin's current Zod, and no Zod internals cross into the official services.
 * Do not use this adapter for tools, JSON Schema conversion, or schema composition.
 * @param schema - Own parser with its exact validated output type.
 * @returns the parsing face consumed by the official projection/storage services.
 */
export function officialValidationSchema<T>(
  schema: ValidationSchema<T>,
): ProjectionDefinition<string, T>['stateSchema'] {
  return {
    parse: (input: unknown) => schema.parse(input),
    safeParse: (input: unknown) => schema.safeParse(input),
  } as ProjectionDefinition<string, T>['stateSchema']
}
