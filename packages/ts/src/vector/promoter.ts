import { detectRuntime } from '../runtime/detect'
import type { VectorSearchEngine } from '../search/vector-search'
import type { HNSWConfig, SerializedHNSWGraph } from './hnsw'
import type { HNSWBuildRequest, HNSWWorkerMessage } from './hnsw-build-worker'

export interface VectorPromoterConfig {
  promotionThreshold?: number
  hnswConfig?: HNSWConfig
}

export interface VectorPromoter {
  check(engines: Map<string, VectorSearchEngine>): void
  shutdown(): void
}

interface WorkerHandle {
  postMessage: (msg: unknown) => void
  on?: (event: string, handler: (msg: unknown) => void) => void
  terminate: () => void
}

function collectVectorsForWorker(engine: VectorSearchEngine): Array<{ docId: string; values: number[] }> {
  const vectors: Array<{ docId: string; values: number[] }> = []
  for (const [, entry] of engine.entries()) {
    vectors.push({ docId: entry.docId, values: Array.from(entry.vector) })
  }
  return vectors
}

function canUseWorkerBuild(): boolean {
  const runtime = detectRuntime()
  if (!runtime.supportsWorkerThreads) return false
  const currentUrl = import.meta.url
  return currentUrl.endsWith('.mjs') || currentUrl.endsWith('.js')
}

function spawnHNSWBuildWorker(
  engine: VectorSearchEngine,
  hnswConfig: HNSWConfig | undefined,
  onComplete: (graph: SerializedHNSWGraph) => void,
  onError: (err: Error) => void,
): { terminate: () => void } {
  const vectors = collectVectorsForWorker(engine)
  const request: HNSWBuildRequest = {
    type: 'build',
    vectors,
    dimension: engine.dimension,
    config: hnswConfig ?? {},
  }

  const entryUrl = new URL('./hnsw-build-worker.mjs', import.meta.url).href
  let worker: WorkerHandle | null = null

  import('node:worker_threads')
    .then(wt => {
      worker = new wt.Worker(entryUrl) as unknown as WorkerHandle
      if (worker.on) {
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
      }
      worker.postMessage(request)
    })
    .catch(onError)

  return {
    terminate() {
      worker?.terminate()
    },
  }
}

export function createVectorPromoter(config?: VectorPromoterConfig): VectorPromoter {
  const threshold = config?.promotionThreshold ?? 10_000
  const hnswConfig = config?.hnswConfig
  const promoting = new Set<string>()

  const useWorkerBuild = canUseWorkerBuild()

  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  const pendingWorkers = new Set<{ terminate: () => void }>()

  return {
    check(engines: Map<string, VectorSearchEngine>): void {
      for (const [field, engine] of engines) {
        if (engine.isPromoted || promoting.has(field)) continue
        if (engine.size < threshold) continue

        promoting.add(field)

        if (useWorkerBuild) {
          const handle = spawnHNSWBuildWorker(
            engine,
            hnswConfig,
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
          const timer = setTimeout(() => {
            pendingTimers.delete(timer)
            try {
              engine.promoteToHNSW(hnswConfig)
            } finally {
              promoting.delete(field)
            }
          }, 0)
          pendingTimers.add(timer)
        }
      }
    },

    shutdown(): void {
      for (const timer of pendingTimers) {
        clearTimeout(timer)
      }
      pendingTimers.clear()

      for (const handle of pendingWorkers) {
        handle.terminate()
      }
      pendingWorkers.clear()

      promoting.clear()
    },
  }
}
