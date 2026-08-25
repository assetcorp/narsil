export type PartitionRole = 'primary' | 'in-sync-replica' | 'lagging-replica' | 'absent'

export type LinkKind = 'coordinator' | 'replication'

export interface PartitionRow {
  partitionId: number
  state: string
  primary: string | null
  primaryTerm: number
  commitPoint: number
  replicas: string[]
  inSyncSet: string[]
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

export interface NodeTally {
  leads: number
  inSync: number
  lagging: number
}

export function partitionRoleOf(row: PartitionRow, nodeId: string): PartitionRole {
  if (row.primary === nodeId) {
    return 'primary'
  }
  if (!row.replicas.includes(nodeId)) {
    return 'absent'
  }
  return row.inSyncSet.includes(nodeId) ? 'in-sync-replica' : 'lagging-replica'
}

export function copyCountOf(row: PartitionRow): number {
  return row.replicas.length + (row.primary === null ? 0 : 1)
}

export function tallyOf(partitions: PartitionRow[], nodeId: string): NodeTally {
  const tally: NodeTally = { leads: 0, inSync: 0, lagging: 0 }
  for (const partition of partitions) {
    const role = partitionRoleOf(partition, nodeId)
    if (role === 'primary') tally.leads += 1
    if (role === 'in-sync-replica') tally.inSync += 1
    if (role === 'lagging-replica') tally.lagging += 1
  }
  return tally
}

export function linkOf(snapshot: ClusterSnapshot, nodeId: string, kind: LinkKind): LinkRow | undefined {
  return snapshot.links.find(link => link.nodeId === nodeId && link.kind === kind)
}

export function cutLinkCountOf(snapshot: ClusterSnapshot): number {
  return snapshot.links.filter(link => link.enabled === false).length
}
