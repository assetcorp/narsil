declare const self: unknown

import { MAX_WORKER_COPIES } from './constants'
import type {
  SharedFieldLoadRequest,
  VectorAckResponse,
  VectorDropRequest,
  VectorInsertRequest,
  VectorInsertResponse,
  VectorLoadRequest,
  VectorOrdinalSearchRequest,
  VectorOrdinalSearchResponse,
  VectorSearchRequest,
  VectorSearchResponse,
  VectorWorkerError,
  VectorWorkerMessage,
  VectorWorkerRequest,
} from './search-pool/messages'
import { openSharedVectorField, type SharedVectorFieldView } from './shared-field/view'
import { restoreWorkerCopy, type WorkerCopy } from './worker-copy'

export type { VectorMetric } from './brute-force'
export type { HNSWSnapshot } from './hnsw'
export type { SharedGraphHandles } from './hnsw/handles'
export type { OrdinalFilter } from './ordinal-filter'
export type { ScalarQuantizerCalibration } from './scalar-quantization-types'
export type {
  SharedFieldLoadRequest,
  VectorAckResponse,
  VectorDropRequest,
  VectorInsertRequest,
  VectorInsertResponse,
  VectorLoadRequest,
  VectorOrdinalSearchRequest,
  VectorOrdinalSearchResponse,
  VectorSearchRequest,
  VectorSearchResponse,
  VectorWorkerError,
  VectorWorkerMessage,
  VectorWorkerRequest,
} from './search-pool/messages'
export type { GrowableBuffer } from './shared-buffers/growable'
export type { GraphInsertOutcome, SharedVectorFieldHandles } from './shared-field/types'
export type { ArenaSimd } from './simd'
export type { VectorStoreSnapshot } from './vector-store'
export type { VectorBlockHandle, VectorBlockLayout, VectorBlockStorage } from './vector-store/blocks'
export type { SharedVectorStoreHandles } from './vector-store/handles'
export type { WorkerCopySnapshot } from './worker-copy'

type LoadedCopy = { kind: 'clone'; copy: WorkerCopy } | { kind: 'shared'; view: SharedVectorFieldView }

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

function handleLoadShared(request: SharedFieldLoadRequest): VectorAckResponse {
  ensureRoom(request.handle)
  const existing = copies.get(request.handle)
  if (existing?.kind === 'shared') {
    existing.view.adopt(request.handles)
  } else {
    copies.set(request.handle, { kind: 'shared', view: openSharedVectorField(request.handles, request.scratchSlot) })
  }
  return { type: 'ack', requestId: request.requestId, handle: request.handle }
}

function handleDrop(request: VectorDropRequest): VectorAckResponse {
  copies.delete(request.handle)
  return { type: 'ack', requestId: request.requestId, handle: request.handle }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => {
    if (typeof setImmediate === 'function') setImmediate(resolve)
    else setTimeout(resolve, 0)
  })
}

async function handleInsert(request: VectorInsertRequest): Promise<VectorInsertResponse> {
  const entry = copies.get(request.handle)
  if (!entry) {
    throw new Error(`Search worker holds no copy for handle ${request.handle}`)
  }
  if (entry.kind !== 'shared') {
    throw new Error(`Handle ${request.handle} holds a cloned copy, which takes no insertions`)
  }
  for (const ordinal of request.ordinals) {
    entry.view.insertOrdinal(ordinal)
    await yieldToEventLoop()
  }
  return { type: 'inserted', requestId: request.requestId, outcome: entry.view.takeOutcome() }
}

function handleSearch(request: VectorSearchRequest): VectorSearchResponse {
  const entry = copies.get(request.handle)
  if (!entry) {
    throw new Error(`Search worker holds no copy for handle ${request.handle}`)
  }
  if (entry.kind !== 'clone') {
    throw new Error(`Handle ${request.handle} holds a shared field, which answers ordinal searches alone`)
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

  const hits = entry.view.searchOrdinals(
    request.query,
    request.k,
    request.metric,
    request.minSimilarity,
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

async function handleAnyRequest(raw: unknown): Promise<VectorWorkerMessage> {
  const request = raw as VectorWorkerRequest
  if (request.type === 'load') return handleLoad(request)
  if (request.type === 'loadShared') return handleLoadShared(request)
  if (request.type === 'drop') return handleDrop(request)
  if (request.type === 'insertOrdinals') return handleInsert(request)
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
      handleAnyRequest(raw).then(
        reply => port.postMessage(reply),
        err => port.postMessage(errorFor(raw, err)),
      )
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
      handleAnyRequest(event.data).then(
        reply => webSelf.postMessage(reply),
        err => webSelf.postMessage(errorFor(event.data, err)),
      )
    }
  }
}

setupWorker()
