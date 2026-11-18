/**
 * Connection facts for external Harnesses, read from the plugin's own public
 * Host API through an admitted caller.
 *
 * The plugin publishes a connection recipe at `GET /api/our-free-model/clients`
 * carrying the running forward endpoint, the issued key and the model ids that
 * lane currently serves. That response is the origin of a legitimate `baseURL`
 * and `apiKey`; reading it is ordinary authenticated use of the plugin's public
 * surface, not a read of its config files and not a guess at a port.
 *
 * Admission is not bypassed here. This module issues no request of its own — it
 * is handed a caller the Host's official wiring already authenticates — and a
 * refusal is treated as a refusal.
 *
 * The base URL is composed from the plugin's published origin and the requested
 * protocol, following the plugin's own recipes: the OpenAI-compatible surfaces
 * (`/v1/responses`, `/v1/chat/completions`) use `<origin>/v1`, while the
 * Anthropic surface (`/v1/messages`) uses `<origin>` and adds the versioned path
 * itself. Recipes are never parsed or executed — a snippet is documentation for a
 * human, and evaluating one would run whatever text the response carried.
 *
 * The issued key is execution data. It is returned to the Host for the launch and
 * never logged, catalogued, embedded in an error, or exposed to a model.
 *
 * @module ofm-source/connection
 */

import type { ExternalWireProtocol } from '../model-sources.ts'
import type { OfmConnectionReader } from './source.ts'
import {
  OFM_PROVIDER,
  ofmHarnessPinsModel,
  ofmProtocol,
  ofmRequiresMainForward,
} from './provider.ts'
import { ofmModelReadiness } from './readiness.ts'

/** One admitted request against the plugin's public API. */
export interface OfmApiRequest {
  /** Absolute URL, built from the Host's own web server base. */
  url: string
  method?: 'GET' | 'POST'
}

/**
 * Performs one request as an already-admitted caller. Supplied by the Host's
 * official Client/Host wiring; a non-2xx status is a refusal and is never retried
 * against another route.
 */
export type OfmApiCaller = (request: OfmApiRequest) => Promise<{ status: number; body: unknown }>

/** The plugin's public API prefix, relative to the Host's web server base. */
export const OFM_API_PREFIX = '/api/our-free-model'

/** Public route carrying the connection recipe. */
export const OFM_CLIENTS_ROUTE = `${OFM_API_PREFIX}/clients`

/** Public route reporting the live catalog and the forward listener state. */
export const OFM_SUMMARY_ROUTE = `${OFM_API_PREFIX}/summary`

/**
 * Compose the base URL for one protocol from the plugin's published origin.
 *
 * Both plugin routes report the same forward listener, so a provider name is
 * never treated as a separate physical endpoint.
 */
export function ofmBaseURL(origin: string, protocol: ExternalWireProtocol | undefined): string {
  return protocol === 'messages' ? origin : `${origin}/v1`
}

/** The subset of the plugin's `/clients` response this module relies on. */
interface ClientsResponse {
  running?: boolean
  baseUrl?: string
  key?: string
  models?: string[]
}

/**
 * Build the connection reader an {@link OfmModelSourceOptions} takes directly,
 * with no adapter at the injection site.
 *
 * Validated against the plugin's own response: the lane must report itself
 * running, the endpoint must be a concrete loopback origin with a real port, the
 * key must be non-empty, and the requested model must still be advertised by that
 * same response. A placeholder origin, a placeholder key or a non-2xx status is a
 * refusal, never a fallback.
 */
export function createOfmApiConnection(caller: OfmApiCaller, base: string): OfmConnectionReader {
  return async (harness, ref, protocol) => {
    // /clients describes only the anonymous forward lane, never the account-channel relay.
    if (ref.provider !== OFM_PROVIDER) return undefined
    const mainForward = ofmRequiresMainForward(harness)
    if (
      mainForward &&
      (!ofmHarnessPinsModel(harness, ref.model) || ofmProtocol(harness) !== protocol)
    )
      return undefined
    // The declared parameter is a `ModelRef`. A bare model id is also read so the
    // reader can be exercised on its own without wrapping it; nothing else about
    // the contract changes.
    const model = typeof ref === 'string' ? ref : ref?.model
    let response: Awaited<ReturnType<OfmApiCaller>>
    try {
      response = await caller({ url: base + OFM_CLIENTS_ROUTE, method: 'GET' })
    } catch (error) {
      if (!mainForward) throw error
      // Owner transport failures must not expose response bodies or issued keys.
      return undefined
    }
    if (response.status < 200 || response.status >= 300) return undefined
    const body = (response.body ?? {}) as ClientsResponse
    if (body.running !== true) return undefined
    const origin = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    // Only a real loopback origin is accepted, so neither the plugin's
    // `<forward-port>` placeholder nor port 0 can reach a launch argument.
    const port = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})$/u.exec(origin)?.[1]
    if (port === undefined || Number(port) < 1 || Number(port) > 65535) return undefined
    const apiKey = typeof body.key === 'string' ? body.key.trim() : ''
    if (apiKey === '' || apiKey === '<forward-key>') return undefined
    const models = Array.isArray(body.models) ? body.models : []
    // The same response decides whether the lane still offers this model, so a
    // withdrawn model cannot launch on a connection that no longer lists it.
    if (typeof model !== 'string' || !models.includes(model)) return undefined
    if (mainForward) {
      let summary: Awaited<ReturnType<OfmApiCaller>>
      try {
        summary = await caller({ url: base + OFM_SUMMARY_ROUTE, method: 'GET' })
      } catch {
        // The owner refusal is final; no alternate route is queried.
        return undefined
      }
      if (summary.status < 200 || summary.status >= 300) return undefined
      if (!ofmModelReadiness(summary.body, ref, true).available) return undefined
      // The forward listener can expose region models too. Its combined roster
      // cannot authorize these clients to use a region-only lane.
      const publicSummary = summary.body as {
        catalog?: { id?: unknown; route?: unknown }[]
        membership?: unknown
      }
      const catalog = publicSummary.catalog
      const entry = Array.isArray(catalog) ? catalog.find((item) => item?.id === model) : undefined
      if (entry?.route !== OFM_PROVIDER) return undefined
      // The current public summary has no membership field. If an owner version
      // supplies it, it must agree with the catalog's main-route assignment.
      const membership = publicSummary.membership
      if (membership !== undefined) {
        if (membership === null || typeof membership !== 'object' || Array.isArray(membership))
          return undefined
        const mainModels = (membership as Record<string, unknown>)[OFM_PROVIDER]
        if (!Array.isArray(mainModels) || !mainModels.includes(model)) return undefined
      }
    }
    return { baseURL: ofmBaseURL(origin, protocol), apiKey }
  }
}
