import { decode } from '@msgpack/msgpack'
import { generateId } from '../../../../core/id-generator'
import { compareCodePoints } from '../../../../core/ordering'
import type {
  AllocationTable,
  ClusterCoordinator,
  NodeRegistration,
  PartitionAssignment,
  UnassignedReason,
} from '../../../coordinator/types'
import type { NodeTransport, TransportMessage } from '../../../transport/types'
import { PARTITION_STORES_TIMEOUT_MS, RECOVERY_CAS_ATTEMPTS } from '../../constants'
import { getIndexMetadata } from '../../index-metadata'
import { lastHoldersOf } from '../../last-holders'
import { createPartitionStoresMessage, validatePartitionStoresResultPayload } from '../../partition-stores'

interface RecoveryDeps {
  coordinator: ClusterCoordinator
  transport: NodeTransport
  controllerNodeId: string
  addressByNodeId: Map<string, string>
  isActive: () => boolean
}

type StoresAnswer = { kind: 'held'; partitionIds: Set<number> } | { kind: 'unreachable' } | { kind: 'identityMismatch' }

function liveHoldersOfUnassignedPartitions(table: AllocationTable, liveNodeIds: Set<string>): string[] {
  const holders = new Set<string>()
  for (const assignment of table.assignments.values()) {
    if (assignment.state !== 'UNASSIGNED') {
      continue
    }
    for (const nodeId of lastHoldersOf(assignment)) {
      if (liveNodeIds.has(nodeId)) {
        holders.add(nodeId)
      }
    }
  }
  return [...holders].sort(compareCodePoints)
}

function hasRecoverablePartition(table: AllocationTable): boolean {
  for (const assignment of table.assignments.values()) {
    if (assignment.state === 'UNASSIGNED' && lastHoldersOf(assignment).length > 0) {
      return true
    }
  }
  return false
}

function reasonFor(
  assignment: PartitionAssignment,
  liveNodeIds: Set<string>,
  answers: Map<string, StoresAnswer>,
): UnassignedReason | undefined {
  const holders = lastHoldersOf(assignment)
  if (holders.length === 0) {
    return undefined
  }
  if (holders.some(nodeId => !liveNodeIds.has(nodeId))) {
    return 'HOLDER_OFFLINE'
  }
  const given = holders.map(nodeId => answers.get(nodeId))
  if (given.some(answer => answer === undefined || answer.kind === 'unreachable')) {
    return 'HOLDER_UNREACHABLE'
  }
  if (given.some(answer => answer?.kind === 'identityMismatch')) {
    return 'HOLDER_IDENTITY_MISMATCH'
  }
  return 'HOLDER_WITHOUT_DATA'
}

function targetsFor(deps: RecoveryDeps, targetNodeId: string): string[] {
  const targets = [targetNodeId]
  const address = deps.addressByNodeId.get(targetNodeId)
  if (address !== undefined && address.length > 0 && address !== targetNodeId) {
    targets.push(address)
  }
  return targets
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs)
    timer.unref?.()
    work
      .then(value => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

async function sendToFirstReachableTarget(
  deps: RecoveryDeps,
  targetNodeId: string,
  message: TransportMessage,
): Promise<TransportMessage | null> {
  for (const target of targetsFor(deps, targetNodeId)) {
    const response = await withTimeout(deps.transport.send(target, message), PARTITION_STORES_TIMEOUT_MS, null)
    if (response !== null) {
      return response
    }
  }
  return null
}

async function askNodeForStores(
  deps: RecoveryDeps,
  targetNodeId: string,
  indexName: string,
  indexUuid: string,
): Promise<StoresAnswer> {
  const message = createPartitionStoresMessage({ indexName }, deps.controllerNodeId, generateId())
  const response = await sendToFirstReachableTarget(deps, targetNodeId, message)
  if (response === null) {
    return { kind: 'unreachable' }
  }
  let answer: ReturnType<typeof validatePartitionStoresResultPayload>
  try {
    answer = validatePartitionStoresResultPayload(decode(response.payload))
  } catch (_) {
    return { kind: 'unreachable' }
  }
  if (answer === null || answer.indexName !== indexName) {
    return { kind: 'unreachable' }
  }
  if (answer.indexUuid !== indexUuid) {
    return { kind: 'identityMismatch' }
  }
  return { kind: 'held', partitionIds: new Set(answer.partitionIds) }
}

function promoteAssignment(assignment: PartitionAssignment, nodeId: string): PartitionAssignment {
  const promoted: PartitionAssignment = {
    ...assignment,
    primary: nodeId,
    replicas: [],
    inSyncSet: [],
    primaryTerm: assignment.primaryTerm + 1,
    state: 'INITIALISING',
  }
  delete promoted.unassignedReason
  return promoted
}

function holderThatAnswered(
  assignment: PartitionAssignment,
  partitionId: number,
  answers: Map<string, StoresAnswer>,
): string | undefined {
  const holders = [...lastHoldersOf(assignment)].sort(compareCodePoints)
  return holders.find(nodeId => {
    const answer = answers.get(nodeId)
    return answer?.kind === 'held' && answer.partitionIds.has(partitionId)
  })
}

function rewriteAssignment(
  assignment: PartitionAssignment,
  partitionId: number,
  liveNodeIds: Set<string>,
  answers: Map<string, StoresAnswer>,
): { assignment: PartitionAssignment; promoted: boolean } | null {
  const holder = holderThatAnswered(assignment, partitionId, answers)
  if (holder !== undefined) {
    return { assignment: promoteAssignment(assignment, holder), promoted: true }
  }

  const reason = reasonFor(assignment, liveNodeIds, answers)
  if (reason === assignment.unassignedReason) {
    return null
  }
  if (reason === undefined) {
    const cleared = { ...assignment }
    delete cleared.unassignedReason
    return { assignment: cleared, promoted: false }
  }
  return { assignment: { ...assignment, unassignedReason: reason }, promoted: false }
}

async function writeRecoveryOutcome(
  deps: RecoveryDeps,
  indexName: string,
  liveNodeIds: Set<string>,
  answers: Map<string, StoresAnswer>,
): Promise<boolean> {
  for (let attempt = 0; attempt < RECOVERY_CAS_ATTEMPTS; attempt++) {
    if (!deps.isActive()) {
      return false
    }
    const table = await deps.coordinator.getAllocation(indexName)
    if (table === null) {
      return false
    }

    const rewritten = new Map<number, PartitionAssignment>()
    let anyPromoted = false
    for (const [partitionId, assignment] of table.assignments) {
      if (assignment.state !== 'UNASSIGNED') {
        continue
      }
      const outcome = rewriteAssignment(assignment, partitionId, liveNodeIds, answers)
      if (outcome === null) {
        continue
      }
      rewritten.set(partitionId, outcome.assignment)
      anyPromoted = anyPromoted || outcome.promoted
    }

    if (rewritten.size === 0) {
      return false
    }

    const assignments = new Map(table.assignments)
    for (const [partitionId, assignment] of rewritten) {
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
      return anyPromoted
    }
  }
  return false
}

/**
 * Gives every partition that no node serves back to a node that still holds its data, and reports whether the
 * allocation table changed.
 *
 * A partition reaches `UNASSIGNED` when its primary fails while no in-sync replica survives, and the allocator
 * records the nodes that still hold it in `lastHolders`. Once one of those nodes registers again, the controller asks it
 * which partitions its local copy holds, and it promotes the node only where the answer names the partition and
 * carries the index identity the coordinator holds, because a copy that fails either test may be missing writes the
 * cluster already acknowledged. A promoted node becomes the primary of an `INITIALISING` partition at a raised term,
 * and it moves the partition to `ACTIVE` once it reports its bootstrap finished. A partition the controller cannot
 * give back carries the reason in `unassignedReason`, from a last holder that has yet to register through to every
 * holder answering without the data, so an operator can tell a partition that is waiting from one that no node can
 * restore. The controller sets no limit on the attempts, because a holder may register again at any time. It waits
 * {@link PARTITION_STORES_TIMEOUT_MS} milliseconds for each answer, so a holder that accepts the request and never
 * answers holds up neither this index's allocation nor any other index's.
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

  if (!hasRecoverablePartition(table) || !isActive()) {
    return false
  }

  const answers = new Map<string, StoresAnswer>()
  const candidateNodeIds = liveHoldersOfUnassignedPartitions(table, liveNodeIds)
  if (candidateNodeIds.length > 0) {
    const metadata = await getIndexMetadata(coordinator, indexName)
    if (metadata === null || !isActive()) {
      return false
    }
    const given = await Promise.all(
      candidateNodeIds.map(nodeId => askNodeForStores(deps, nodeId, indexName, metadata.indexUuid)),
    )
    for (let index = 0; index < candidateNodeIds.length; index += 1) {
      answers.set(candidateNodeIds[index], given[index])
    }
  }

  return writeRecoveryOutcome(deps, indexName, liveNodeIds, answers)
}
