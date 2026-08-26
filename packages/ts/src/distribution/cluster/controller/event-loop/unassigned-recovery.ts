import { decode } from '@msgpack/msgpack'
import { generateId } from '../../../../core/id-generator'
import { compareCodePoints } from '../../../../core/ordering'
import type {
  AllocationTable,
  ClusterCoordinator,
  NodeRegistration,
  PartitionAssignment,
} from '../../../coordinator/types'
import type { NodeTransport, TransportMessage } from '../../../transport/types'
import { getIndexMetadata } from '../../index-metadata'
import { createPartitionStoresMessage, validatePartitionStoresResultPayload } from '../../partition-stores'

const RECOVERY_CAS_ATTEMPTS = 5

interface RecoveryDeps {
  coordinator: ClusterCoordinator
  transport: NodeTransport
  controllerNodeId: string
  addressByNodeId: Map<string, string>
  isActive: () => boolean
}

function unassignedHoldersByNode(table: AllocationTable, liveNodeIds: Set<string>): Map<string, number[]> {
  const partitionsByNode = new Map<string, number[]>()
  for (const [partitionId, assignment] of table.assignments) {
    if (assignment.state !== 'UNASSIGNED') {
      continue
    }
    for (const nodeId of assignment.inSyncSet) {
      if (!liveNodeIds.has(nodeId)) {
        continue
      }
      const partitionIds = partitionsByNode.get(nodeId)
      if (partitionIds === undefined) {
        partitionsByNode.set(nodeId, [partitionId])
        continue
      }
      partitionIds.push(partitionId)
    }
  }
  return partitionsByNode
}

function targetsFor(deps: RecoveryDeps, targetNodeId: string): string[] {
  const targets = [targetNodeId]
  const address = deps.addressByNodeId.get(targetNodeId)
  if (address !== undefined && address.length > 0 && address !== targetNodeId) {
    targets.push(address)
  }
  return targets
}

async function sendToFirstReachableTarget(
  deps: RecoveryDeps,
  targetNodeId: string,
  message: TransportMessage,
): Promise<TransportMessage | null> {
  for (const target of targetsFor(deps, targetNodeId)) {
    try {
      return await deps.transport.send(target, message)
    } catch (_) {}
  }
  return null
}

async function askNodeForStores(
  deps: RecoveryDeps,
  targetNodeId: string,
  indexName: string,
  indexUuid: string,
): Promise<Set<number>> {
  const message = createPartitionStoresMessage({ indexName }, deps.controllerNodeId, generateId())
  const response = await sendToFirstReachableTarget(deps, targetNodeId, message)
  if (response === null) {
    return new Set()
  }
  try {
    const answer = validatePartitionStoresResultPayload(decode(response.payload))
    if (answer === null || answer.indexName !== indexName || answer.indexUuid !== indexUuid) {
      return new Set()
    }
    return new Set(answer.partitionIds)
  } catch (_) {
    return new Set()
  }
}

function promoteAssignment(assignment: PartitionAssignment, nodeId: string): PartitionAssignment {
  return {
    ...assignment,
    primary: nodeId,
    replicas: [],
    inSyncSet: [],
    primaryTerm: assignment.primaryTerm + 1,
    state: 'INITIALISING',
  }
}

async function writePromotions(
  deps: RecoveryDeps,
  indexName: string,
  storesByNode: Map<string, Set<number>>,
): Promise<boolean> {
  for (let attempt = 0; attempt < RECOVERY_CAS_ATTEMPTS; attempt++) {
    if (!deps.isActive()) {
      return false
    }
    const table = await deps.coordinator.getAllocation(indexName)
    if (table === null) {
      return false
    }

    const promoted = new Map<number, PartitionAssignment>()
    for (const [partitionId, assignment] of table.assignments) {
      if (assignment.state !== 'UNASSIGNED') {
        continue
      }
      const holders = [...assignment.inSyncSet].sort(compareCodePoints)
      const holder = holders.find(nodeId => storesByNode.get(nodeId)?.has(partitionId) === true)
      if (holder === undefined) {
        continue
      }
      promoted.set(partitionId, promoteAssignment(assignment, holder))
    }

    if (promoted.size === 0) {
      return false
    }

    const assignments = new Map(table.assignments)
    for (const [partitionId, assignment] of promoted) {
      assignments.set(partitionId, assignment)
    }

    if (!deps.isActive()) {
      return false
    }

    const written = await deps.coordinator.putAllocation(
      indexName,
      { ...table, version: table.version + 1, assignments },
      table.version,
    )
    if (written) {
      return true
    }
  }
  return false
}

/**
 * Gives every partition that no node serves back to a node that still holds its data, and reports whether the
 * allocation table changed.
 *
 * A partition reaches `UNASSIGNED` when its primary fails while no in-sync replica survives, and the allocator
 * records the nodes that last held it in `inSyncSet`. Once one of those nodes registers again, the controller asks it
 * which partitions its local copy holds, and it promotes the node only where the answer names the partition and
 * carries the index identity the coordinator holds, because a copy that fails either test may be missing writes the
 * cluster already acknowledged. A promoted node becomes the primary of an `INITIALISING` partition at a raised term,
 * and it moves the partition to `ACTIVE` once it reports its bootstrap finished.
 *
 * @param coordinator - The cluster coordinator that holds the allocation table and the index identity.
 * @param transport - The node transport the controller asks the returning nodes over.
 * @param indexName - The index whose unserved partitions this pass tries to recover.
 * @param controllerNodeId - The controller's own node id, which names the sender of every request.
 * @param nodes - The nodes registered with the coordinator right now, whose addresses this pass sends to.
 * @param isActive - Reports whether this node still holds the controller lease.
 * @returns True where the controller promoted at least one node, and false where it found nothing to recover.
 */
export async function recoverUnassignedPartitions(
  coordinator: ClusterCoordinator,
  transport: NodeTransport,
  indexName: string,
  controllerNodeId: string,
  nodes: NodeRegistration[],
  isActive: () => boolean,
): Promise<boolean> {
  const addressByNodeId = new Map(nodes.map(node => [node.nodeId, node.address]))
  const liveNodeIds = new Set(addressByNodeId.keys())
  const deps: RecoveryDeps = { coordinator, transport, controllerNodeId, addressByNodeId, isActive }
  if (!isActive()) {
    return false
  }

  const table = await coordinator.getAllocation(indexName)
  if (table === null) {
    return false
  }

  const partitionsByNode = unassignedHoldersByNode(table, liveNodeIds)
  if (partitionsByNode.size === 0 || !isActive()) {
    return false
  }

  const metadata = await getIndexMetadata(coordinator, indexName)
  if (metadata === null || !isActive()) {
    return false
  }

  const candidateNodeIds = [...partitionsByNode.keys()].sort(compareCodePoints)
  const answers = await Promise.all(
    candidateNodeIds.map(nodeId => askNodeForStores(deps, nodeId, indexName, metadata.indexUuid)),
  )

  const storesByNode = new Map<string, Set<number>>()
  for (let index = 0; index < candidateNodeIds.length; index += 1) {
    storesByNode.set(candidateNodeIds[index], answers[index])
  }

  return writePromotions(deps, indexName, storesByNode)
}
