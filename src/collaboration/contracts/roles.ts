export interface RoleExecutionCatalog {
  bindings: Record<string, string>
  presets: { id: string; name: string; broken?: string }[]
  combinations: { id: string; name: string; harness: string; available: boolean; reason?: string }[]
}
