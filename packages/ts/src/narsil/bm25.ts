import { updateIndexBm25 } from '../engine/bm25-update'
import type { EngineCore } from '../engine/core'
import type { BM25Operations } from '../types/bm25-operations'
import type { BM25Params } from '../types/schema'

export function bm25Operations(core: EngineCore): BM25Operations {
  return {
    async updateBM25(indexName: string, bm25: BM25Params): Promise<void> {
      await updateIndexBm25(core, indexName, bm25)
    },
  }
}
