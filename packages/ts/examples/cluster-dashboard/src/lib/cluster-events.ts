import type { ClusterSnapshot, PartitionRow } from './cluster-types'
import { recoveryTextOf } from './cluster-types'

export type ClusterEventKind =
  | 'node'
  | 'controller'
  | 'leadership'
  | 'replication'
  | 'unserved'
  | 'recovery'
  | 'link'
  | 'index'

export interface ClusterEvent {
  id: string
  at: string
  kind: ClusterEventKind
  text: string
}

type EventDraft = Omit<ClusterEvent, 'id' | 'at'>

export const CLUSTER_EVENT_LIMIT = 100

/**
 * Puts a fresh batch of events at the top of the list the dashboard shows, newest first.
 *
 * The function leaves both arguments untouched, so React may run the same update twice and still reach the same
 * list.
 *
 * @param current - The events on screen, newest first.
 * @param fresh - The events a snapshot turned up, oldest first.
 * @returns The list to show, newest first, cut to {@link CLUSTER_EVENT_LIMIT}.
 */
export function mergeClusterEvents(current: ClusterEvent[], fresh: ClusterEvent[]): ClusterEvent[] {
  const newestFirst = [...fresh].reverse()
  return [...newestFirst, ...current].slice(0, CLUSTER_EVENT_LIMIT)
}

function partitionsById(partitions: PartitionRow[]): Map<number, PartitionRow> {
  return new Map(partitions.map(partition => [partition.partitionId, partition]))
}

function namesOf(holders: string[]): string {
  if (holders.length === 2) {
    return `${holders[0]} and ${holders[1]}`
  }
  return `${holders.slice(0, -1).join(', ')}, and ${holders[holders.length - 1]}`
}

function holdersTextOf(partition: PartitionRow): string {
  const holders = partition.lastHolders
  if (holders.length === 0) {
    return 'no node holds a copy of it'
  }
  if (holders.length === 1) {
    return `${holders[0]} still holds a copy`
  }
  return `${namesOf(holders)} still hold a copy`
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

function recoveredText(partition: PartitionRow): string {
  if (partition.primary === null) {
    return `p${partition.partitionId} is out of the unserved state`
  }
  return partition.state === 'INITIALISING'
    ? `p${partition.partitionId} comes back on ${partition.primary}, which is filling its copy`
    : `p${partition.partitionId} serves again from ${partition.primary}`
}

function stateDraftOf(before: PartitionRow, partition: PartitionRow): EventDraft | null {
  if (before.state === partition.state) {
    const reason = recoveryTextOf(partition)
    if (reason === null || before.unassignedReason === partition.unassignedReason) {
      return null
    }
    return { kind: 'unserved', text: `p${partition.partitionId} stays unserved, because ${reason}` }
  }
  if (partition.state === 'UNASSIGNED') {
    return {
      kind: 'unserved',
      text: `p${partition.partitionId} lost every copy that served it, and ${holdersTextOf(partition)}`,
    }
  }
  if (before.state === 'UNASSIGNED') {
    return { kind: 'recovery', text: recoveredText(partition) }
  }
  if (before.state === 'INITIALISING' && partition.state === 'ACTIVE' && partition.primary !== null) {
    return { kind: 'recovery', text: `p${partition.partitionId} finished filling and serves from ${partition.primary}` }
  }
  return null
}

function stateEvents(previous: Map<number, PartitionRow>, next: ClusterSnapshot): EventDraft[] {
  const drafts: EventDraft[] = []

  for (const partition of next.partitions) {
    const before = previous.get(partition.partitionId)
    if (before === undefined) {
      continue
    }
    const draft = stateDraftOf(before, partition)
    if (draft !== null) {
      drafts.push(draft)
    }
  }

  return drafts
}

function leadershipEvents(previous: Map<number, PartitionRow>, next: ClusterSnapshot): EventDraft[] {
  const drafts: EventDraft[] = []

  for (const partition of next.partitions) {
    const before = previous.get(partition.partitionId)
    if (before === undefined || before.primary === partition.primary || partition.primary === null) {
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
    if (partition.state !== 'UNASSIGNED') {
      for (const nodeId of before.inSyncSet) {
        if (!partition.inSyncSet.includes(nodeId) && partition.primary !== nodeId) {
          drafts.push({ kind: 'replication', text: `p${partition.partitionId} drops ${nodeId} from its in-sync set` })
        }
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

  if (previous.controllerNodeId !== next.controllerNodeId) {
    drafts.push({
      kind: 'controller',
      text:
        next.controllerNodeId === null
          ? `${previous.controllerNodeId ?? 'the last controller'} let the controller lease expire, so no node holds it`
          : `${next.controllerNodeId} holds the controller lease`,
    })
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
 * expires, the controller promotes a replica, and the in-sync set narrows and fills again. A partition that loses
 * every copy carries its own line, which names the nodes that still hold one and then the reason the controller
 * records while it waits for one of them.
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
    ...stateEvents(before, next),
    ...leadershipEvents(before, next),
    ...replicationEvents(before, next),
    ...clusterEvents(previous, next),
  ]

  return drafts.map((draft, index) => ({
    ...draft,
    id: `${next.updatedAt}-${index}-${draft.text}`,
    at: next.updatedAt,
  }))
}
