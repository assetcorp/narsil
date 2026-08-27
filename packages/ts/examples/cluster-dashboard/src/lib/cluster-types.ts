import type { UnassignedReason } from '@delali/narsil/distribution'

export type PartitionRole = 'primary' | 'in-sync-replica' | 'lagging-replica' | 'last-holder' | 'absent'

export type LinkKind = 'coordinator' | 'replication'

export interface PartitionRow {
  partitionId: number
  state: string
  primary: string | null
  primaryTerm: number
  commitPoint: number
  replicas: string[]
  inSyncSet: string[]
  lastHolders: string[]
  unassignedReason: UnassignedReason | null
}

export interface ClusterNodeRow {
  nodeId: string
  address: string | null
  roles: string[]
  startedAt: string | null
  version: string | null
  registered: boolean
}

export interface LinkRow {
  nodeId: string
  kind: LinkKind
  proxyName: string
  enabled: boolean | null
}

export interface ClusterSnapshot {
  updatedAt: string
  indexName: string
  indexExists: boolean
  allocationVersion: number | null
  replicationFactor: number | null
  controllerNodeId: string | null
  nodes: ClusterNodeRow[]
  partitions: PartitionRow[]
  links: LinkRow[]
  coordinatorError: string | null
  faultInjectorError: string | null
}

export function partitionRoleOf(row: PartitionRow, nodeId: string): PartitionRole {
  if (row.primary === nodeId) {
    return 'primary'
  }
  if (!row.replicas.includes(nodeId)) {
    return row.lastHolders.includes(nodeId) ? 'last-holder' : 'absent'
  }
  return row.inSyncSet.includes(nodeId) ? 'in-sync-replica' : 'lagging-replica'
}

export function copyCountOf(row: PartitionRow): number {
  return row.replicas.length + (row.primary === null ? 0 : 1)
}

export function partitionIdsOf(partitions: PartitionRow[], nodeId: string, role: PartitionRole): number[] {
  return partitions.filter(partition => partitionRoleOf(partition, nodeId) === role).map(p => p.partitionId)
}

export function linkOf(snapshot: ClusterSnapshot, nodeId: string, kind: LinkKind): LinkRow | undefined {
  return snapshot.links.find(link => link.nodeId === nodeId && link.kind === kind)
}

export function cutLinkCountOf(snapshot: ClusterSnapshot): number {
  return snapshot.links.filter(link => link.enabled === false).length
}

const RECOVERY_TEXT: Record<UnassignedReason, string> = {
  HOLDER_OFFLINE: 'a holder has yet to register again',
  HOLDER_UNREACHABLE: 'a registered holder left the enquiry unanswered',
  HOLDER_IDENTITY_MISMATCH: 'a holder answered for an earlier index of the same name',
  HOLDER_WITHOUT_DATA: 'every holder answered without the partition',
}

export function recoveryTextOf(row: PartitionRow): string | null {
  if (row.state !== 'UNASSIGNED') {
    return null
  }
  if (row.unassignedReason === null) {
    return row.lastHolders.length === 0 ? 'no node ever held this partition' : 'the controller is asking the holders'
  }
  return RECOVERY_TEXT[row.unassignedReason]
}
