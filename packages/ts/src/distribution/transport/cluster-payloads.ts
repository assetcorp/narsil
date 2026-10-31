export interface PingPayload {
  timestamp: number
}

export interface PongPayload {
  timestamp: number
  respondedAt: number
}

export interface BootstrapCompletePayload {
  indexName: string
  partitionId: number
  nodeId: string
  primaryTerm: number
}

export interface ReplicationFactorPayload {
  indexName: string
  replicationFactor: number
}

export interface BootstrapCompleteResultPayload {
  indexName: string
  partitionId: number
  accepted: boolean
}

export interface PartitionStoresPayload {
  indexName: string
}

export interface RebuildAnalysisPayload {
  indexName: string
  indexUuid: string
  generation?: number
}

export interface RebuildAnalysisResultPayload {
  indexName: string
  rebuiltPartitions: number[]
  generation?: number
}

export interface PartitionStoresResultPayload {
  indexName: string
  indexUuid: string | null
  partitionIds: number[]
}

export interface IndexSettingsPayload {
  indexName: string
  indexUuid: string
}

export interface IndexSettingsResultPayload {
  indexName: string
  applied: boolean
}
