import type { BoundsFreshness, FeedChange, FeedRead, PartitionBounds } from '../sync/feed/source'
import type { DocumentTest } from './derive'

export interface ChangesIndexState {
  epoch: string
  partitionCount: number
  previousDocument: boolean
}

export interface ChangeSource {
  changesState(indexName: string): ChangesIndexState | null
  documentTest(indexName: string, filter: unknown): Promise<DocumentTest>
  vectorFieldPaths(indexName: string): Promise<ReadonlySet<string>>
  bounds(indexName: string, partitionId: number, freshness?: BoundsFreshness): Promise<PartitionBounds>
  read(
    indexName: string,
    partitionId: number,
    afterSeqNo: number,
    upToSeqNo: number,
    maxBytes: number,
  ): Promise<FeedRead>
  bytesBehind(indexName: string, seqNos: readonly number[]): Promise<number>
  pendingBeyondHead(indexName: string, partitionId: number, head: number): boolean
  listen(onChange: (change: FeedChange) => void): () => void
  watchIndex?(indexName: string): () => void
}
