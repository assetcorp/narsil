import { detectRuntime } from '../runtime/detect'
import type { VectorSearchEngine } from '../search/vector-search'
import type { HNSWConfig, SerializedHNSWGraph } from './hnsw'
import type { HNSWBuildRequest, HNSWWorkerMessage } from './hnsw-build-worker'

export type WorkerStrategy = 'worker-threads' | 'web-worker' | 'synchronous'

export interface VectorPromoterConfig {
  promotionThreshold?: number
  hnswConfig?: HNSWConfig
  workerStrategy?: WorkerStrategy
}

export interface VectorPromoter {
  check(engines: Map<string, VectorSearchEngine>): void
  shutdown(): void
  readonly strategy: WorkerStrategy
}

export function detectWorkerStrategy(): WorkerStrategy {
  const runtime = detectRuntime()
  const url = import.meta.url
  const hasBundledWorker = url.endsWith('.mjs') || url.endsWith('.js')

  if (runtime.supportsWorkerThreads && hasBundledWorker) return 'worker-threads'
  if (runtime.supportsWebWorkers && hasBundledWorker) return 'web-worker'
  return 'synchronous'
}

function collectVectorsForWorker(engine: VectorSearchEngine): Array<{ docId: string; values: number[] }> {
  const vectors: Array<{ docId: string; values: number[] }> = []
  for (const [, entry] of engine.entries()) {
    vectors.push({ docId: entry.docId, values: Array.from(entry.vector) })
  }
  return vectors
}

function buildWorkerRequest(engine: VectorSearchEngine, hnswConfig: HNSWConfig | undefined): HNSWBuildRequest {
  return {
    type: 'build',
    vectors: collectVectorsForWorker(engine),
    dimension: engine.dimension,
    config: hnswConfig ?? {},
  }
}

function resolveWorkerUrl(): string {
  const base = import.meta.url
  const distIndex = base.lastIndexOf('/dist/')
  if (distIndex !== -1) {
    return new URL('vector/hnsw-build-worker.mjs', base.slice(0, distIndex + 6)).href
  }
  return base.replace(/\/src\/vector\/[^/]+$/, '/dist/vector/hnsw-build-worker.mjs')
}

function spawnNodeWorker(
  request: HNSWBuildRequest,
  onComplete: (graph: SerializedHNSWGraph) => void,
  onError: (err: Error) => void,
): { terminate: () => void } {
  const entryUrl = resolveWorkerUrl()
  type NodeWorker = {
    postMessage: (msg: unknown) => void
    on: (event: string, handler: (msg: unknown) => void) => void
    terminate: () => void
  }
  let worker: NodeWorker | null = null

  import('node:worker_threads')
    .then(wt => {
      worker = new wt.Worker(new URL(entryUrl)) as NodeWorker
      worker.on('message', (msg: unknown) => {
        const response = msg as HNSWWorkerMessage
        worker?.terminate()
        if (response.type === 'success') {
          onComplete(response.graph)
        } else {
          onError(new Error(response.message))
        }
      })
      worker.on('error', (err: unknown) => {
        worker?.terminate()
        onError(err instanceof Error ? err : new Error(String(err)))
      })
      worker.postMessage(request)
    })
    .catch(onError)

  return {
    terminate() {
      worker?.terminate()
    },
  }
}

function spawnWebWorker(
  request: HNSWBuildRequest,
  onComplete: (graph: SerializedHNSWGraph) => void,
  onError: (err: Error) => void,
): { terminate: () => void } {
  const entryUrl = resolveWorkerUrl()
  const WorkerCtor = (
    globalThis as unknown as {
      Worker: new (
        url: string,
        opts?: { type: string },
      ) => {
        postMessage: (msg: unknown) => void
        terminate: () => void
        onmessage: ((event: { data: unknown }) => void) | null
        onerror: ((event: { message?: string; error?: Error }) => void) | null
      }
    }
  ).Worker

  const worker = new WorkerCtor(entryUrl, { type: 'module' })

  worker.onmessage = (event: { data: unknown }) => {
    const response = event.data as HNSWWorkerMessage
    worker.terminate()
    if (response.type === 'success') {
      onComplete(response.graph)
    } else {
      onError(new Error(response.message))
    }
  }

  worker.onerror = (event: { message?: string; error?: Error }) => {
    worker.terminate()
    onError(event.error ?? new Error(event.message ?? 'Web Worker error'))
  }

  worker.postMessage(request)

  return {
    terminate() {
      worker.terminate()
    },
  }
}

export function createVectorPromoter(config?: VectorPromoterConfig): VectorPromoter {
  const threshold = config?.promotionThreshold ?? 10_000
  const hnswConfig = config?.hnswConfig
  const promoting = new Set<string>()
  const strategy = config?.workerStrategy ?? detectWorkerStrategy()

  const pendingWorkers = new Set<{ terminate: () => void }>()

  return {
    get strategy() {
      return strategy
    },

    check(engines: Map<string, VectorSearchEngine>): void {
      for (const [field, engine] of engines) {
        if (engine.isPromoted || promoting.has(field)) continue
        if (engine.size < threshold) continue

        promoting.add(field)

        if (strategy === 'worker-threads') {
          const request = buildWorkerRequest(engine, hnswConfig)
          const handle = spawnNodeWorker(
            request,
            graph => {
              pendingWorkers.delete(handle)
              if (!engine.isPromoted) {
                engine.deserializeHNSW(graph)
              }
              promoting.delete(field)
            },
            () => {
              pendingWorkers.delete(handle)
              promoting.delete(field)
            },
          )
          pendingWorkers.add(handle)
        } else if (strategy === 'web-worker') {
          const request = buildWorkerRequest(engine, hnswConfig)
          const handle = spawnWebWorker(
            request,
            graph => {
              pendingWorkers.delete(handle)
              if (!engine.isPromoted) {
                engine.deserializeHNSW(graph)
              }
              promoting.delete(field)
            },
            () => {
              pendingWorkers.delete(handle)
              promoting.delete(field)
            },
          )
          pendingWorkers.add(handle)
        } else {
          try {
            engine.promoteToHNSW(hnswConfig)
          } finally {
            promoting.delete(field)
          }
        }
      }
    },

    shutdown(): void {
      for (const handle of pendingWorkers) {
        handle.terminate()
      }
      pendingWorkers.clear()
      promoting.clear()
    },
  }
}
