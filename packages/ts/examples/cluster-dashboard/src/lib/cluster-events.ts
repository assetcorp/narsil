import type { ClusterSnapshot, PartitionRow } from './cluster-types'

export type ClusterEventKind = 'node' | 'controller' | 'leadership' | 'replication' | 'link' | 'index'

export interface ClusterEvent {
  id: string
  at: string
  kind: ClusterEventKind
  text: string
}

type EventDraft = Omit<ClusterEvent, 'id' | 'at'>

function partitionsById(partitions: PartitionRow[]): Map<number, PartitionRow> {
  return new Map(partitions.map(partition => [partition.partitionId, partition]))
}

function nodeEvents(previous: ClusterSnapshot, next: ClusterSnapshot): EventDraft[] {
  const wasRegistered = new Map(previous.nodes.map(node => [node.nodeId, node.registered]))
  const drafts: EventDraft[] = []

  for (const node of next.nodes) {
    const before = wasRegistered.get(node.nodeId)
    if (before === undefined || before === node.registered) {
      continue
    }
    drafts.push({
      kind: 'node',
      text: node.registered
        ? `${node.nodeId} registered with the coordinator again`
        : `${node.nodeId} lost its registration, because its lease expired`,
    })
  }

  return drafts
}

function linkEvents(previous: ClusterSnapshot, next: ClusterSnapshot): EventDraft[] {
  const wasEnabled = new Map(previous.links.map(link => [link.proxyName, link.enabled]))
  const drafts: EventDraft[] = []

  for (const link of next.links) {
    const before = wasEnabled.get(link.proxyName)
    if (before === undefined || before === link.enabled || link.enabled === null) {
      continue
    }
    drafts.push({
      kind: 'link',
      text: link.enabled
        ? `${link.nodeId} has its ${link.kind} link back`
        : `${link.nodeId} lost its ${link.kind} link to a cut`,
    })
  }

  return drafts
}

function leadershipEvents(previous: Map<number, PartitionRow>, next: ClusterSnapshot): EventDraft[] {
  const drafts: EventDraft[] = []

  for (const partition of next.partitions) {
    const before = previous.get(partition.partitionId)
    if (before === undefined || before.primary === partition.primary) {
      continue
    }
    if (partition.primary === null) {
      drafts.push({ kind: 'leadership', text: `p${partition.partitionId} has no primary and serves nothing` })
      continue
    }
    drafts.push({
      kind: 'leadership',
      text:
        before.primary === null
          ? `p${partition.partitionId} takes ${partition.primary} as primary at term ${partition.primaryTerm}`
          : `p${partition.partitionId} promotes ${partition.primary} over ${before.primary} at term ${partition.primaryTerm}`,
    })
  }

  return drafts
}

function replicationEvents(previous: Map<number, PartitionRow>, next: ClusterSnapshot): EventDraft[] {
  const drafts: EventDraft[] = []

  for (const partition of next.partitions) {
    const before = previous.get(partition.partitionId)
    if (before === undefined) {
      continue
    }
    for (const nodeId of before.inSyncSet) {
      if (!partition.inSyncSet.includes(nodeId) && partition.primary !== nodeId) {
        drafts.push({ kind: 'replication', text: `p${partition.partitionId} drops ${nodeId} from its in-sync set` })
      }
    }
    for (const nodeId of partition.inSyncSet) {
      if (!before.inSyncSet.includes(nodeId)) {
        drafts.push({ kind: 'replication', text: `p${partition.partitionId} admits ${nodeId} to its in-sync set` })
      }
    }
  }

  return drafts
}

function clusterEvents(previous: ClusterSnapshot, next: ClusterSnapshot): EventDraft[] {
  const drafts: EventDraft[] = []

  if (previous.controllerNodeId !== next.controllerNodeId && next.controllerNodeId !== null) {
    drafts.push({ kind: 'controller', text: `${next.controllerNodeId} holds the controller lease` })
  }

  if (previous.indexExists !== next.indexExists) {
    drafts.push({
      kind: 'index',
      text: next.indexExists
        ? `the index '${next.indexName}' is allocated across the cluster`
        : `the index '${next.indexName}' no longer has an allocation`,
    })
  }

  return drafts
}

/**
 * Reports what changed between two coordinator snapshots, as one entry for each change.
 *
 * The dashboard keeps these entries in a log, so that a failover reads as a sequence a person can follow: the lease
 * expires, the controller promotes a replica, and the in-sync set narrows and fills again.
 *
 * @param previous - The snapshot the dashboard held before this update.
 * @param next - The snapshot the dashboard has now received.
 * @returns The events in reading order, which is empty where nothing changed.
 */
export function diffSnapshots(previous: ClusterSnapshot, next: ClusterSnapshot): ClusterEvent[] {
  const before = partitionsById(previous.partitions)
  const drafts = [
    ...nodeEvents(previous, next),
    ...linkEvents(previous, next),
    ...leadershipEvents(before, next),
    ...replicationEvents(before, next),
    ...clusterEvents(previous, next),
  ]

  return drafts.map((draft, index) => ({ ...draft, id: `${next.updatedAt}-${index}`, at: next.updatedAt }))
}
