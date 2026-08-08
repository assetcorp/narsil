declare const self: unknown

import type { VectorMetric } from './brute-force'
import { restoreReplica, type VectorReplica, type VectorReplicaSnapshot } from './replica'

export type { VectorMetric } from './brute-force'
export type { HNSWSnapshot } from './hnsw'
export type { AdjacencySnapshot } from './hnsw/adjacency'
export type { VectorReplicaSnapshot } from './replica'
export type { ScalarQuantizerCalibration } from './scalar-quantization-types'
export type { VectorStoreSnapshot } from './vector-store'

/**
 * Asks the search worker to hold a replica of one vector field under a handle.
 *
 * This module is the worker's own entry point, and the engine posts these
 * messages to it. It exists so that a bundler can resolve the worker file, and
 * nothing here is part of the engine's supported surface.
 *
 * @internal
 */
export interface VectorLoadRequest {
  /** This marks the message as a replica load. */
  type: 'load'
  /** Later messages name the replica by this handle. */
  handle: string
  /** The worker rebuilds its searchable copy from this. */
  snapshot: VectorReplicaSnapshot
}

/**
 * Asks the search worker to release a replica it holds.
 *
 * @internal
 */
export interface VectorDropRequest {
  /** This marks the message as a replica release. */
  type: 'drop'
  /** The worker releases the replica held under this handle. */
  handle: string
}

/**
 * Asks the search worker to answer one nearest-neighbour query.
 *
 * @internal
 */
export interface VectorSearchRequest {
  /** This marks the message as a search. */
  type: 'search'
  /** The reply carries this back so the engine can match it to its caller. */
  requestId: string
  /** The worker searches the replica held under this handle. */
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
 * Either message the engine posts to the search worker.
 *
 * @internal
 */
export type VectorWorkerRequest = VectorLoadRequest | VectorDropRequest | VectorSearchRequest

/**
 * What the search worker returns once a replica is loaded or released.
 *
 * @internal
 */
export interface VectorAckResponse {
  /** This marks the message as a completed load or release. */
  type: 'ack'
  /** This names the replica the acknowledgement belongs to. */
  handle: string
}

/**
 * What the search worker returns for a completed search.
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
export type VectorWorkerMessage = VectorAckResponse | VectorSearchResponse | VectorWorkerError

const MAX_REPLICAS = 64

const replicas = new Map<string, VectorReplica>()

function handleLoad(request: VectorLoadRequest): VectorAckResponse {
  if (!replicas.has(request.handle) && replicas.size >= MAX_REPLICAS) {
    throw new Error(`Search worker already holds ${MAX_REPLICAS} replicas`)
  }
  replicas.set(request.handle, restoreReplica(request.snapshot))
  return { type: 'ack', handle: request.handle }
}

function handleDrop(request: VectorDropRequest): VectorAckResponse {
  replicas.delete(request.handle)
  return { type: 'ack', handle: request.handle }
}

function handleSearch(request: VectorSearchRequest): VectorSearchResponse {
  const replica = replicas.get(request.handle)
  if (!replica) {
    throw new Error(`Search worker holds no replica for handle ${request.handle}`)
  }

  const hits = replica.graph.search(
    request.query,
    request.k,
    request.metric,
    request.minSimilarity,
    undefined,
    request.efSearch,
  )

  const docIds: string[] = []
  const scores = new Float64Array(hits.length)
  for (let i = 0; i < hits.length; i++) {
    docIds.push(hits[i].docId)
    scores[i] = hits[i].score
  }

  return { type: 'result', requestId: request.requestId, docIds, scores }
}

function handleAnyRequest(raw: unknown): VectorWorkerMessage {
  const request = raw as VectorWorkerRequest
  if (request.type === 'load') return handleLoad(request)
  if (request.type === 'drop') return handleDrop(request)
  if (request.type === 'search') return handleSearch(request)
  throw new Error(`Unknown request type: ${(request as { type: string }).type}`)
}

function errorFor(raw: unknown, err: unknown): VectorWorkerError {
  const message = err instanceof Error ? err.message : String(err)
  const requestId = (raw as { requestId?: unknown }).requestId
  return typeof requestId === 'string' ? { type: 'error', requestId, message } : { type: 'error', message }
}

function setupWorker(): void {
  setupAsync().catch(err => {
    console.error('Vector search worker setup failed:', err)
  })
}

async function setupAsync(): Promise<void> {
  let parentPort: {
    on: (event: string, handler: (msg: unknown) => void) => void
    postMessage: (msg: unknown) => void
  } | null = null

  try {
    const workerThreads = await import('node:worker_threads')
    parentPort = workerThreads.parentPort ?? null
  } catch {
    parentPort = null
  }

  if (parentPort) {
    const port = parentPort
    port.on('message', (raw: unknown) => {
      try {
        port.postMessage(handleAnyRequest(raw))
      } catch (err) {
        port.postMessage(errorFor(raw, err))
      }
    })
    return
  }

  const globalSelf = typeof self !== 'undefined' ? self : undefined
  if (globalSelf && typeof (globalSelf as { postMessage?: unknown }).postMessage === 'function') {
    const webSelf = globalSelf as unknown as {
      onmessage: ((event: { data: unknown }) => void) | null
      postMessage: (msg: unknown) => void
    }

    webSelf.onmessage = (event: { data: unknown }) => {
      try {
        webSelf.postMessage(handleAnyRequest(event.data))
      } catch (err) {
        webSelf.postMessage(errorFor(event.data, err))
      }
    }
  }
}

setupWorker()
