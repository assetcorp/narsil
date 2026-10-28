import type { Narsil } from '../types/engine'
import type { IndexInfo, IndexStats, PartitionStatsResult } from '../types/results'

export interface IndexReads {
  listIndexes(): Promise<IndexInfo[]>
  getStats(indexName: string): Promise<IndexStats>
  getPartitionStats(indexName: string): Promise<PartitionStatsResult[]>
}

const boundReads = new WeakMap<object, IndexReads>()

export function bindIndexReads(engine: Narsil, reads: IndexReads): void {
  boundReads.set(engine, reads)
}

export function indexReadsOf(engine: Narsil): IndexReads {
  const bound = boundReads.get(engine)
  if (bound !== undefined) return bound
  return {
    listIndexes: async () => engine.listIndexes(),
    getStats: async indexName => engine.getStats(indexName),
    getPartitionStats: async indexName => engine.getPartitionStats(indexName),
  }
}
