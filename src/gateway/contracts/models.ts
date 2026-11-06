/** Provider-specific model fields must remain lossless JSON across the settings editor. */
export type ModelConfigValue =
  | string
  | number
  | boolean
  | null
  | readonly ModelConfigValue[]
  | { [key: string]: ModelConfigValue }
export type ModelDraft = { id: string; name?: string; contextWindow?: number } & Record<
  string,
  ModelConfigValue
>
/** Safe failure fields shared by model listing, account status, and the existing Models page. */
export interface GatewayModelDiagnostic {
  code:
    | 'disabled'
    | 'missing_credentials'
    | 'invalid_credentials'
    | 'authentication'
    | 'http'
    | 'network'
    | 'timeout'
    | 'service_unavailable'
    | 'configuration'
    | 'settings_conflict'
    | 'invalid_response'
    | 'discovery_failed'
  message: string
  status?: number
}
/** A successful listing confirms candidate metadata, not inference or image support. */
export interface GatewayCatalogStatus {
  state: 'unverified' | 'ready' | 'empty' | 'error'
  count?: number
  diagnostic?: GatewayModelDiagnostic
}
export interface GatewayModelSettings {
  groups: {
    id: string
    name: string
    api: string
    models: ModelDraft[]
    enabled?: boolean
    rateMultiplier?: number
    /** Credential readiness only; catalog state records listing evidence separately. */
    ready: boolean
    catalog?: GatewayCatalogStatus
    state: 'ready' | 'unauthorized' | 'unconfigured' | 'error'
    revision: number
  }[]
}
