export interface RebalancePayload {
  indexName: string
  targetPartitionCount: number
}

export interface RebalanceResultPayload {
  indexName: string
  jobId: string
  targetGeneration: string
}

export interface ReshardStartPayload {
  indexName: string
  jobId: string
  sourceGeneration: string
  targetGeneration: string
  partitionId: number
  sourcePartitionCount: number
  targetPartitionCount: number
}

export interface ReshardStartResultPayload {
  jobId: string
  partitionId: number
  snapshotSeqNo: number
}

export interface ReshardForwardOperation {
  documentId: string
  operation: 'replace' | 'remove'
  document?: Uint8Array
}

export interface ReshardForwardPayload {
  targetGeneration: string
  jobId: string
  sourcePartitionId: number
  sourcePrimaryTerm: number
  operations: ReshardForwardOperation[]
}

export interface ReshardCutoverPayload {
  indexName: string
  jobId: string
  partitionId: number
  action: 'block' | 'lift'
}

export interface ReshardCutoverResultPayload {
  jobId: string
  partitionId: number
  lastSeqNo: number
}

export interface ReshardPurgePayload {
  targetGeneration: string
  jobId: string
  sourcePartitionCount: number
  sourcePartitionId: number
}

export interface ReshardPurgeResultPayload {
  removed: number
}
