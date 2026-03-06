import type { VectorSearchEngine } from '../search/vector-search'
import type { HNSWConfig } from './hnsw'

export interface VectorPromoterConfig {
  promotionThreshold?: number
  hnswConfig?: HNSWConfig
}

export interface VectorPromoter {
  check(engines: Map<string, VectorSearchEngine>): void
  shutdown(): void
}

export function createVectorPromoter(config?: VectorPromoterConfig): VectorPromoter {
  const threshold = config?.promotionThreshold ?? 10_000
  const hnswConfig = config?.hnswConfig
  const promoting = new Set<string>()
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

  return {
    check(engines: Map<string, VectorSearchEngine>): void {
      for (const [field, engine] of engines) {
        if (engine.isPromoted || promoting.has(field)) continue
        if (engine.size < threshold) continue

        promoting.add(field)
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
    },

    shutdown(): void {
      for (const timer of pendingTimers) {
        clearTimeout(timer)
      }
      pendingTimers.clear()
      promoting.clear()
    },
  }
}
