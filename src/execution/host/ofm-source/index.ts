/**
 * Public entry for the Our Free Model external-execution source. The suite's
 * assembly owns mounting; everything a mounting plugin needs is exported here.
 *
 * @module ofm-source/index
 */

export {
  OFM_EXCLUDED_MODELS,
  OFM_HARNESS_PROTOCOLS,
  OFM_PINNED_HARNESS_MODELS,
  OFM_PROVIDER,
  OFM_PROVIDERS,
  OFM_REGION_PROVIDER,
  isExcludedOfmModel,
  isExcludedOfmRef,
  isUsableOfmModelId,
  ofmHarnessKey,
  ofmHarnessPinsModel,
  ofmProtocol,
  ofmRequiresMainForward,
  type OfmWireProtocol,
} from './provider.ts'
export {
  OFM_API_PREFIX,
  OFM_CLIENTS_ROUTE,
  OFM_SUMMARY_ROUTE,
  createOfmApiConnection,
  ofmBaseURL,
  type OfmApiCaller,
  type OfmApiRequest,
} from './connection.ts'
export {
  applyOfmModelSource,
  createOfmModelSource,
  type OfmConnectionFacts,
  type OfmConnectionReader,
  type OfmModelSourceOptions,
} from './source.ts'
