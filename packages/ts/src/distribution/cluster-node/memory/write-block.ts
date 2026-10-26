import { compareCodePoints } from '../../../core/ordering'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable, ClusterCoordinator, NodeEvent } from '../../coordinator/types'

const NODE_MEMORY_FULL_REASON = 'node_memory_full'

export interface NodeMemoryView {
  fullNodeIds(): ReadonlySet<string>
  start(): Promise<void>
  stop(): void
}

export interface NodeMemoryViewOptions {
  coordinator: ClusterCoordinator
  localNodeId: string
  localIsFull: () => boolean
}

export function createNodeMemoryView(options: NodeMemoryViewOptions): NodeMemoryView {
  const registeredFull = new Set<string>()
  let unwatch: (() => void) | null = null

  function record(nodeId: string, full: boolean): void {
    if (full) {
      registeredFull.add(nodeId)
    } else {
      registeredFull.delete(nodeId)
    }
  }

  return {
    fullNodeIds() {
      const fullNodeIds = new Set(registeredFull)
      fullNodeIds.delete(options.localNodeId)
      if (options.localIsFull()) {
        fullNodeIds.add(options.localNodeId)
      }
      return fullNodeIds
    },

    async start() {
      if (unwatch !== null) {
        return
      }
      const reportedByWatch = new Set<string>()
      unwatch = await options.coordinator.watchNodes((event: NodeEvent) => {
        reportedByWatch.add(event.nodeId)
        record(event.nodeId, event.registration?.memory?.full === true)
      })
      for (const node of await options.coordinator.listNodes()) {
        if (!reportedByWatch.has(node.nodeId)) {
          record(node.nodeId, node.memory?.full === true)
        }
      }
    },

    stop() {
      if (unwatch !== null) {
        unwatch()
        unwatch = null
      }
      registeredFull.clear()
    },
  }
}

function copyHoldersOf(table: AllocationTable): Set<string> {
  const holders = new Set<string>()
  for (const assignment of table.assignments.values()) {
    if (assignment.primary !== null) {
      holders.add(assignment.primary)
    }
    for (const replica of assignment.replicas) {
      holders.add(replica)
    }
  }
  return holders
}

export function findWriteBlock(table: AllocationTable, view: NodeMemoryView | undefined): NarsilError | null {
  if (view === undefined) {
    return null
  }
  const fullNodeIds = view.fullNodeIds()
  if (fullNodeIds.size === 0) {
    return null
  }
  const blockingNodeIds = [...copyHoldersOf(table)].filter(nodeId => fullNodeIds.has(nodeId)).sort(compareCodePoints)
  if (blockingNodeIds.length === 0) {
    return null
  }
  const quotedNodeIds = blockingNodeIds.map(nodeId => `'${nodeId}'`).join(', ')
  const holders =
    blockingNodeIds.length === 1
      ? `node ${quotedNodeIds} holds a copy of it and reports`
      : `nodes ${quotedNodeIds} hold copies of it and report`
  return new NarsilError(
    ErrorCodes.CLUSTER_WRITE_BLOCKED,
    `Index '${table.indexName}' refuses inserts and updates because ${holders} full memory. Remove documents from the indexes on that node or give it more memory, and writes resume once its memory falls below the resume threshold.`,
    { reason: NODE_MEMORY_FULL_REASON, indexName: table.indexName, fullNodeIds: blockingNodeIds },
  )
}

export function requireWritableIndex(table: AllocationTable, view: NodeMemoryView | undefined): void {
  const block = findWriteBlock(table, view)
  if (block !== null) {
    throw block
  }
}
