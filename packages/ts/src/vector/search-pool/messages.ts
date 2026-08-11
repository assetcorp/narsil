import type { VectorMetric } from '../brute-force'
import type { SharedGenerationSnapshot } from '../shared-generation/types'
import type { WorkerCopySnapshot } from '../worker-copy'

/**
 * Asks the search worker to hold a cloned copy of one vector field under a
 * handle.
 *
 * These messages travel between the engine and its search worker entry point,
 * and nothing here is part of the engine's supported surface.
 *
 * @internal
 */
export interface VectorLoadRequest {
  /** This marks the message as a cloned copy load. */
  type: 'load'
  /** The reply carries this back so the engine can match it to its caller. */
  requestId: string
  /** Later messages name the copy by this handle. */
  handle: string
  /** The worker rebuilds its searchable copy from this. */
  snapshot: WorkerCopySnapshot
}

/**
 * Asks the search worker to open a frozen shared copy under a handle.
 *
 * @internal
 */
export interface SharedCopyLoadRequest {
  /** This marks the message as a shared copy load. */
  type: 'loadShared'
  /** The reply carries this back so the engine can match it to its caller. */
  requestId: string
  /** Later messages name the copy by this handle. */
  handle: string
  /** The worker writes query scratch into this reserved slot alone. */
  scratchSlot: number
  /** The frozen copy, its buffers shared rather than cloned. */
  snapshot: SharedGenerationSnapshot
}

/**
 * Asks the search worker to release a copy it holds.
 *
 * @internal
 */
export interface VectorDropRequest {
  /** This marks the message as a copy release. */
  type: 'drop'
  /** The reply carries this back so the engine can match it to its caller. */
  requestId: string
  /** The worker releases the copy held under this handle. */
  handle: string
}

/**
 * Asks the search worker to answer one nearest-neighbour query from a cloned
 * copy.
 *
 * @internal
 */
export interface VectorSearchRequest {
  /** This marks the message as a search over a cloned copy. */
  type: 'search'
  /** The reply carries this back so the engine can match it to its caller. */
  requestId: string
  /** The worker searches the copy held under this handle. */
  handle: string
  /** The worker ranks against this query vector. */
  query: Float32Array
  /** The worker returns at most this many results. */
  k: number
  /** The worker ranks by this metric. */
  metric: VectorMetric
  /** The worker drops any result scoring below this. */
  minSimilarity: number
  /** The worker explores this many candidates, or its own default when absent. */
  efSearch?: number
}

/**
 * Asks the search worker to answer one nearest-neighbour query from a shared
 * copy, returning ordinals for the engine to map back to document ids.
 *
 * @internal
 */
export interface VectorOrdinalSearchRequest {
  /** This marks the message as a search over a shared copy. */
  type: 'searchOrdinals'
  /** The reply carries this back so the engine can match it to its caller. */
  requestId: string
  /** The worker searches the copy held under this handle. */
  handle: string
  /** The worker ranks against this query vector. */
  query: Float32Array
  /** The worker returns at most this many results. */
  k: number
  /** The worker ranks by this metric. */
  metric: VectorMetric
  /** The worker drops any result scoring below this. */
  minSimilarity: number
  /** The worker explores this many candidates, or its own default when absent. */
  efSearch?: number
}

/**
 * Every message the engine posts to the search worker.
 *
 * @internal
 */
export type VectorWorkerRequest =
  | VectorLoadRequest
  | SharedCopyLoadRequest
  | VectorDropRequest
  | VectorSearchRequest
  | VectorOrdinalSearchRequest

/**
 * What the search worker returns once a copy is loaded or released.
 *
 * @internal
 */
export interface VectorAckResponse {
  /** This marks the message as a completed load or release. */
  type: 'ack'
  /** This matches the request the engine sent. */
  requestId: string
  /** This names the copy the acknowledgement belongs to. */
  handle: string
}

/**
 * What the search worker returns for a completed search over a cloned copy.
 *
 * @internal
 */
export interface VectorSearchResponse {
  /** This marks the message as a completed search. */
  type: 'result'
  /** This matches the request the engine sent. */
  requestId: string
  /** These document ids run best first. */
  docIds: string[]
  /** These scores line up with the document ids. */
  scores: Float64Array
}

/**
 * What the search worker returns for a completed search over a shared copy.
 *
 * @internal
 */
export interface VectorOrdinalSearchResponse {
  /** This marks the message as a completed ordinal search. */
  type: 'ordinalResult'
  /** This matches the request the engine sent. */
  requestId: string
  /** These store ordinals run best first. */
  ordinals: Uint32Array
  /** These scores line up with the ordinals. */
  scores: Float64Array
}

/**
 * What the search worker returns when a request fails.
 *
 * @internal
 */
export interface VectorWorkerError {
  /** This marks the message as a failure. */
  type: 'error'
  /** This matches the request the engine sent, and is absent for a load or release. */
  requestId?: string
  /** This says why the request failed. */
  message: string
}

/**
 * Every message the search worker posts back.
 *
 * @internal
 */
export type VectorWorkerMessage =
  | VectorAckResponse
  | VectorSearchResponse
  | VectorOrdinalSearchResponse
  | VectorWorkerError
