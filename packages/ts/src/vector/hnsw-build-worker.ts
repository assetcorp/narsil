declare const self: unknown

import { createHNSWIndex, type HNSWConfig, type SerializedHNSWGraph } from './hnsw'
import { createVectorStore } from './vector-store'

export type { VectorMetric } from './brute-force'
export type { HNSWConfig, SerializedHNSWGraph } from './hnsw'

/**
 * Asks the build worker to construct a graph from vectors sent as arrays.
 *
 * This module is the worker's own entry point, and the engine posts these
 * messages to it. It exists so that a bundler can resolve the worker file, and
 * nothing here is part of the engine's supported surface.
 *
 * @internal
 */
export interface HNSWBuildRequest {
  /** This marks the message as an array-form build request. */
  type: 'build'
  /** The worker indexes these vectors, each carrying the document id it belongs to. */
  vectors: Array<{ docId: string; values: number[] }>
  /** Each vector carries this many components. */
  dimension: number
  /** The worker builds to this graph shape, clamped to safe bounds first. */
  config: HNSWConfig
}

/**
 * Asks the build worker to construct a graph from vectors packed into one
 * transferable buffer, which is what the engine sends for a large field.
 *
 * @internal
 */
export interface HNSWBuildRequestBinary {
  /** This marks the message as a packed-buffer build request. */
  type: 'build-binary'
  /** These document ids run in the order their vectors appear in the buffer. */
  docIds: string[]
  /** This holds every vector end to end, `docIds.length * dimension` components long. */
  vectorData: Float32Array
  /** Each vector carries this many components. */
  dimension: number
  /** The worker builds to this graph shape, clamped to safe bounds first. */
  config: HNSWConfig
}

/**
 * What the build worker returns once a graph is built.
 *
 * @internal
 */
export interface HNSWBuildResponse {
  /** This marks the message as a completed build. */
  type: 'success'
  /** This graph is ready for the engine to adopt. */
  graph: SerializedHNSWGraph
}

/**
 * What the build worker returns when a build fails.
 *
 * @internal
 */
export interface HNSWBuildError {
  /** This marks the message as a failed build. */
  type: 'error'
  /** This says why the build failed. */
  message: string
}

/**
 * Either message the build worker posts back.
 *
 * @internal
 */
export type HNSWWorkerMessage = HNSWBuildResponse | HNSWBuildError

const MAX_WORKER_DIMENSION = 8192
const MAX_WORKER_VECTORS = 1_000_000

function validateBuildRequest(request: HNSWBuildRequest): void {
  if (typeof request.dimension !== 'number' || request.dimension <= 0 || request.dimension > MAX_WORKER_DIMENSION) {
    throw new Error(`Invalid dimension: ${request.dimension} (must be 1..${MAX_WORKER_DIMENSION})`)
  }
  if (!Array.isArray(request.vectors)) {
    throw new Error('vectors must be an array')
  }
  if (request.vectors.length > MAX_WORKER_VECTORS) {
    throw new Error(`Too many vectors: ${request.vectors.length} (max ${MAX_WORKER_VECTORS})`)
  }
  for (let i = 0; i < request.vectors.length; i++) {
    const entry = request.vectors[i]
    if (typeof entry.docId !== 'string' || !Array.isArray(entry.values)) {
      throw new Error(`Invalid vector entry at index ${i}`)
    }
    if (entry.values.length !== request.dimension) {
      throw new Error(`Vector at index ${i} has ${entry.values.length} elements, expected ${request.dimension}`)
    }
  }
}

function clampHNSWConfig(config: HNSWConfig): HNSWConfig {
  return {
    ...config,
    m: config.m != null ? Math.max(2, Math.min(64, config.m)) : undefined,
    efConstruction: config.efConstruction != null ? Math.max(10, Math.min(1000, config.efConstruction)) : undefined,
  }
}

/**
 * Builds a graph from an array-form request, which is the worker's own handler
 * and carries no support promise.
 *
 * @param request - The vectors to index, their dimension, and the graph shape.
 * @returns The graph the worker posts back.
 *
 * @internal
 */
function handleBuildRequest(request: HNSWBuildRequest): SerializedHNSWGraph {
  validateBuildRequest(request)
  const safeConfig = clampHNSWConfig(request.config)
  const store = createVectorStore()
  for (const entry of request.vectors) {
    store.insert(entry.docId, new Float32Array(entry.values))
  }
  const hnsw = createHNSWIndex(request.dimension, store, safeConfig)
  for (const entry of request.vectors) {
    hnsw.insertNode(entry.docId)
  }
  return hnsw.serialize()
}

function handleBuildRequestBinary(request: HNSWBuildRequestBinary): SerializedHNSWGraph {
  const { docIds, vectorData, dimension, config } = request
  if (!Number.isInteger(dimension) || dimension <= 0 || dimension > MAX_WORKER_DIMENSION) {
    throw new Error(`Invalid dimension: ${dimension} (must be 1..${MAX_WORKER_DIMENSION})`)
  }
  if (docIds.length > MAX_WORKER_VECTORS) {
    throw new Error(`Too many vectors: ${docIds.length} (max ${MAX_WORKER_VECTORS})`)
  }
  const expectedLength = docIds.length * dimension
  if (vectorData.length !== expectedLength) {
    throw new Error(
      `vectorData length ${vectorData.length} does not match ${docIds.length} * ${dimension} = ${expectedLength}`,
    )
  }

  const safeConfig = clampHNSWConfig(config)
  const store = createVectorStore()
  for (let i = 0; i < docIds.length; i++) {
    const offset = i * dimension
    const vec = vectorData.subarray(offset, offset + dimension)
    store.insert(docIds[i], new Float32Array(vec))
  }

  const hnsw = createHNSWIndex(dimension, store, safeConfig)
  for (const docId of docIds) {
    hnsw.insertNode(docId)
  }
  return hnsw.serialize()
}

function handleAnyRequest(raw: unknown): SerializedHNSWGraph {
  const request = raw as { type: string }
  if (request.type === 'build') {
    return handleBuildRequest(raw as HNSWBuildRequest)
  }
  if (request.type === 'build-binary') {
    return handleBuildRequestBinary(raw as HNSWBuildRequestBinary)
  }
  throw new Error(`Unknown request type: ${request.type}`)
}

function setupWorker(): void {
  setupAsync().catch(err => {
    console.error('HNSW build worker setup failed:', err)
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
        const graph = handleAnyRequest(raw)
        port.postMessage({ type: 'success', graph } satisfies HNSWBuildResponse)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        port.postMessage({ type: 'error', message } satisfies HNSWBuildError)
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
        const graph = handleAnyRequest(event.data)
        webSelf.postMessage({ type: 'success', graph } satisfies HNSWBuildResponse)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        webSelf.postMessage({ type: 'error', message } satisfies HNSWBuildError)
      }
    }
  }
}

export { handleBuildRequest }

setupWorker()
