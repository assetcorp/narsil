declare const self: unknown

import { MAX_WORKER_COPIES } from './constants'
import { searchOrdinals } from './hnsw/search'
import type {
  SharedCopyLoadRequest,
  VectorAckResponse,
  VectorDropRequest,
  VectorLoadRequest,
  VectorOrdinalSearchRequest,
  VectorOrdinalSearchResponse,
  VectorSearchRequest,
  VectorSearchResponse,
  VectorWorkerError,
  VectorWorkerMessage,
  VectorWorkerRequest,
} from './search-pool/messages'
import { openSharedWorkerCopy, type SharedWorkerCopy } from './shared-generation/worker-view'
import { restoreWorkerCopy, type WorkerCopy } from './worker-copy'

export type { VectorMetric } from './brute-force'
export type { HNSWSnapshot } from './hnsw'
export type { AdjacencySnapshot } from './hnsw/adjacency'
export type { OrdinalFilter } from './ordinal-filter'
export type { ScalarQuantizerCalibration } from './scalar-quantization-types'
export type {
  SharedCopyLoadRequest,
  VectorAckResponse,
  VectorDropRequest,
  VectorLoadRequest,
  VectorOrdinalSearchRequest,
  VectorOrdinalSearchResponse,
  VectorSearchRequest,
  VectorSearchResponse,
  VectorWorkerError,
  VectorWorkerMessage,
  VectorWorkerRequest,
} from './search-pool/messages'
export type { SharedGenerationLayout, SharedGenerationSnapshot } from './shared-generation/types'
export type { VectorStoreSnapshot } from './vector-store'
export type { WorkerCopySnapshot } from './worker-copy'

type LoadedCopy = { kind: 'clone'; copy: WorkerCopy } | { kind: 'shared'; copy: SharedWorkerCopy }

const copies = new Map<string, LoadedCopy>()

function ensureRoom(handle: string): void {
  if (!copies.has(handle) && copies.size >= MAX_WORKER_COPIES) {
    throw new Error(`Search worker already holds ${MAX_WORKER_COPIES} copies`)
  }
}

function handleLoad(request: VectorLoadRequest): VectorAckResponse {
  ensureRoom(request.handle)
  copies.set(request.handle, { kind: 'clone', copy: restoreWorkerCopy(request.snapshot) })
  return { type: 'ack', requestId: request.requestId, handle: request.handle }
}

function handleLoadShared(request: SharedCopyLoadRequest): VectorAckResponse {
  ensureRoom(request.handle)
  copies.set(request.handle, { kind: 'shared', copy: openSharedWorkerCopy(request.snapshot, request.scratchSlot) })
  return { type: 'ack', requestId: request.requestId, handle: request.handle }
}

function handleDrop(request: VectorDropRequest): VectorAckResponse {
  copies.delete(request.handle)
  return { type: 'ack', requestId: request.requestId, handle: request.handle }
}

function handleSearch(request: VectorSearchRequest): VectorSearchResponse {
  const entry = copies.get(request.handle)
  if (!entry) {
    throw new Error(`Search worker holds no copy for handle ${request.handle}`)
  }
  if (entry.kind !== 'clone') {
    throw new Error(`Handle ${request.handle} holds a shared copy, which answers ordinal searches alone`)
  }

  const hits = entry.copy.graph.search(
    request.query,
    request.k,
    request.metric,
    request.minSimilarity,
    request.filter,
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

function handleSearchOrdinals(request: VectorOrdinalSearchRequest): VectorOrdinalSearchResponse {
  const entry = copies.get(request.handle)
  if (!entry) {
    throw new Error(`Search worker holds no copy for handle ${request.handle}`)
  }
  if (entry.kind !== 'shared') {
    throw new Error(`Handle ${request.handle} holds a cloned copy, which answers document id searches alone`)
  }

  const hits = searchOrdinals(
    entry.copy.searchState,
    request.query,
    request.k,
    request.metric,
    request.minSimilarity,
    entry.copy.rankByOrdinal,
    request.filter,
    request.efSearch,
  )

  const ordinals = new Uint32Array(hits.length)
  const scores = new Float64Array(hits.length)
  for (let i = 0; i < hits.length; i++) {
    ordinals[i] = hits[i].ord
    scores[i] = hits[i].score
  }

  return { type: 'ordinalResult', requestId: request.requestId, ordinals, scores }
}

function handleAnyRequest(raw: unknown): VectorWorkerMessage {
  const request = raw as VectorWorkerRequest
  if (request.type === 'load') return handleLoad(request)
  if (request.type === 'loadShared') return handleLoadShared(request)
  if (request.type === 'drop') return handleDrop(request)
  if (request.type === 'search') return handleSearch(request)
  if (request.type === 'searchOrdinals') return handleSearchOrdinals(request)
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
