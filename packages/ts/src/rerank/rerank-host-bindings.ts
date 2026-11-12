import type { OptionalCodeHost } from '../engine/optional-code-host'

type RerankHost = Pick<
  OptionalCodeHost,
  | 'applyHighlights'
  | 'DEFAULT_LIMIT'
  | 'DEFAULT_MAX_RERANK_WINDOW'
  | 'DEFAULT_OFFSET'
  | 'DEFAULT_RERANK_TIMEOUT_MS'
  | 'DEFAULT_RERANK_WINDOW'
  | 'ErrorCodes'
  | 'HYBRID_RESCORE_WINDOW'
  | 'MAX_HYBRID_DEPTH'
  | 'MAX_CALLS_ACROSS_INDEX_CHANGES'
  | 'MAX_RERANK_TIMEOUT_MS'
  | 'MAX_RERANK_WINDOW'
  | 'MIN_HYBRID_DEPTH'
  | 'MIN_RERANK_TIMEOUT_MS'
  | 'MIN_RERANK_WINDOW'
  | 'NarsilError'
  | 'RESULT_WINDOW'
>

export let applyHighlights: RerankHost['applyHighlights']
export let DEFAULT_LIMIT: RerankHost['DEFAULT_LIMIT']
export let DEFAULT_MAX_RERANK_WINDOW: RerankHost['DEFAULT_MAX_RERANK_WINDOW']
export let DEFAULT_OFFSET: RerankHost['DEFAULT_OFFSET']
export let DEFAULT_RERANK_TIMEOUT_MS: RerankHost['DEFAULT_RERANK_TIMEOUT_MS']
export let DEFAULT_RERANK_WINDOW: RerankHost['DEFAULT_RERANK_WINDOW']
export let ErrorCodes: RerankHost['ErrorCodes']
export let HYBRID_RESCORE_WINDOW: RerankHost['HYBRID_RESCORE_WINDOW']
export let MAX_HYBRID_DEPTH: RerankHost['MAX_HYBRID_DEPTH']
export let MAX_CALLS_ACROSS_INDEX_CHANGES: RerankHost['MAX_CALLS_ACROSS_INDEX_CHANGES']
export let MAX_RERANK_TIMEOUT_MS: RerankHost['MAX_RERANK_TIMEOUT_MS']
export let MAX_RERANK_WINDOW: RerankHost['MAX_RERANK_WINDOW']
export let MIN_HYBRID_DEPTH: RerankHost['MIN_HYBRID_DEPTH']
export let MIN_RERANK_TIMEOUT_MS: RerankHost['MIN_RERANK_TIMEOUT_MS']
export let MIN_RERANK_WINDOW: RerankHost['MIN_RERANK_WINDOW']
export let NarsilError: RerankHost['NarsilError']
export type NarsilError = InstanceType<RerankHost['NarsilError']>
export let RESULT_WINDOW: RerankHost['RESULT_WINDOW']

export function bindRerankHost(host: RerankHost): void {
  ;({
    applyHighlights,
    DEFAULT_LIMIT,
    DEFAULT_MAX_RERANK_WINDOW,
    DEFAULT_OFFSET,
    DEFAULT_RERANK_TIMEOUT_MS,
    DEFAULT_RERANK_WINDOW,
    ErrorCodes,
    HYBRID_RESCORE_WINDOW,
    MAX_HYBRID_DEPTH,
    MAX_CALLS_ACROSS_INDEX_CHANGES,
    MAX_RERANK_TIMEOUT_MS,
    MAX_RERANK_WINDOW,
    MIN_HYBRID_DEPTH,
    MIN_RERANK_TIMEOUT_MS,
    MIN_RERANK_WINDOW,
    NarsilError,
    RESULT_WINDOW,
  } = host)
}
