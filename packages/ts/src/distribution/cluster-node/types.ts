import type { Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { BatchResult, QueryResult } from '../../types/results'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { AllocationTable, ClusterCoordinator, NodeCapacity, NodeRole } from '../coordinator/types'
import type { NodeTransport } from '../transport/types'

export interface ClusterNodeConfig {
  coordinator: ClusterCoordinator
  transport: NodeTransport
  address: string
  roles?: NodeRole[]
  nodeId?: string
  capacity?: NodeCapacity
  engine?: NarsilConfig
  onError?: (error: Error) => void
}

export interface CreateIndexOptions {
  partitionCount?: number
  replicationFactor?: number
}

export interface ClusterNamespace {
  getAllocation(indexName: string): Promise<AllocationTable | null>
  getNodeInfo(): ClusterNodeInfo
  isControllerActive(): boolean
}

export interface ClusterNodeInfo {
  nodeId: string
  roles: ReadonlyArray<NodeRole>
  status: string
}

export interface ClusterNode {
  readonly nodeId: string
  readonly roles: ReadonlyArray<NodeRole>

  createIndex(name: string, config: IndexConfig, options?: CreateIndexOptions): Promise<void>
  insert(indexName: string, document: AnyDocument, docId?: string): Promise<string>
  insertBatch(indexName: string, documents: AnyDocument[]): Promise<BatchResult>
  remove(indexName: string, docId: string): Promise<void>
  removeBatch(indexName: string, docIds: string[]): Promise<BatchResult>
  query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>>

  cluster: ClusterNamespace

  start(): Promise<void>
  shutdown(): Promise<void>
}

export interface ClusterNodeDeps {
  nodeId: string
  roles: ReadonlyArray<NodeRole>
  coordinator: ClusterCoordinator
  transport: NodeTransport
  engine: Narsil
  address: string
}

export const DEFAULT_PARTITION_COUNT = 5
export const DEFAULT_REPLICATION_FACTOR = 1
export const DEFAULT_CAPACITY: NodeCapacity = {
  memoryBytes: 8_000_000_000,
  cpuCores: 4,
  diskBytes: null,
}
