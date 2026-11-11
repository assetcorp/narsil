import type { LogFrame } from '../../persistence/durability/sync/frame-cursor'
import type { SyncSettings } from '../protocol'

export interface PartitionBounds {
  oldestSeqNo: number
  head: number
  highestSeqNo: number
}

export type BoundsFreshness = 'recent' | 'current'

export interface FeedRead {
  frames: LogFrame[]
  gone: boolean
}

export interface FeedIndexState {
  epoch: string
  partitionCount: number
  settings: SyncSettings
}

export type FeedChange =
  | { kind: 'epoch'; indexName: string }
  | { kind: 'off'; indexName: string }
  | { kind: 'settings'; indexName: string }
  | { kind: 'dropped'; indexName: string }
  | { kind: 'advanced'; indexName: string }

export interface FeedSource {
  indexState(indexName: string): FeedIndexState | null
  bounds(indexName: string, partitionId: number, freshness?: BoundsFreshness): Promise<PartitionBounds>
  read(
    indexName: string,
    partitionId: number,
    afterSeqNo: number,
    upToSeqNo: number,
    maxBytes: number,
  ): Promise<FeedRead>
  bytesBehind(indexName: string, seqNos: readonly number[]): Promise<number>
  snapshotBytes(indexName: string): Promise<number>
  pendingBeyondHead(indexName: string, partitionId: number, head: number): boolean
  listen(onChange: (change: FeedChange) => void): () => void
  watchIndex?(indexName: string): () => void
}
