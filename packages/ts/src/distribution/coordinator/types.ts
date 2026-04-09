import type { SchemaDefinition } from '../../types/schema'

export type NodeRole = 'data' | 'coordinator' | 'controller'

export type PartitionState = 'UNASSIGNED' | 'INITIALISING' | 'ACTIVE' | 'MIGRATING' | 'DECOMMISSIONING'

export interface NodeCapacity {
  memoryBytes: number
  cpuCores: number
  diskBytes: number | null
}

export interface NodeRegistration {
  nodeId: string
  address: string
  roles: NodeRole[]
  capacity: NodeCapacity
  startedAt: string
  version: string
}

export interface PartitionAssignment {
  primary: string | null
  replicas: string[]
  inSyncSet: string[]
  state: PartitionState
  primaryTerm: number
}

export interface AllocationTable {
  indexName: string
  version: number
  replicationFactor: number
  assignments: Map<number, PartitionAssignment>
}

export interface NodeEvent {
  type: 'node_joined' | 'node_left'
  nodeId: string
  registration: NodeRegistration | null
}

export interface AllocationEvent {
  indexName: string
  table: AllocationTable
}

export interface SchemaEvent {
  type: 'schema_created' | 'schema_dropped'
  indexName: string
  schema: SchemaDefinition | null
}

export interface AllocationConstraints {
  zoneAwareness: boolean
  zoneAttribute: string
  maxShardsPerNode: number | null
}

export interface ClusterCoordinator {
  registerNode(registration: NodeRegistration): Promise<void>
  deregisterNode(nodeId: string): Promise<void>
  listNodes(): Promise<NodeRegistration[]>
  watchNodes(handler: (event: NodeEvent) => void): Promise<() => void>

  getAllocation(indexName: string): Promise<AllocationTable | null>
  putAllocation(indexName: string, table: AllocationTable): Promise<void>
  watchAllocation(handler: (event: AllocationEvent) => void): Promise<() => void>

  getPartitionState(indexName: string, partitionId: number): Promise<PartitionState>
  putPartitionState(indexName: string, partitionId: number, state: PartitionState): Promise<void>

  acquireLease(key: string, nodeId: string, ttlMs: number): Promise<boolean>
  renewLease(key: string, nodeId: string, ttlMs: number): Promise<boolean>
  releaseLease(key: string): Promise<void>

  compareAndSet(key: string, expected: Uint8Array | null, value: Uint8Array): Promise<boolean>

  getSchema(indexName: string): Promise<SchemaDefinition | null>
  putSchema(indexName: string, schema: SchemaDefinition): Promise<void>
  watchSchemas(handler: (event: SchemaEvent) => void): Promise<() => void>

  getLeaseHolder(key: string): Promise<string | null>

  shutdown(): Promise<void>
}
