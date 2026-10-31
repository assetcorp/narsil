import { ErrorCodes, NarsilError } from '../../errors'
import { BM25_TUNING_SPEC_VERSION, reachesVersion } from '../cluster/version'
import type { AllocationTable, PartitionAssignment } from '../coordinator/types'
import type { NodeRegistration } from '../coordinator/types/node'
import { copyHoldersOf } from './selection'

function withRegisteredCopies(assignment: PartitionAssignment, registered: ReadonlySet<string>): PartitionAssignment {
  return {
    ...assignment,
    primary: assignment.primary !== null && registered.has(assignment.primary) ? assignment.primary : null,
    replicas: assignment.replicas.filter(replica => registered.has(replica)),
  }
}

export function bm25NotReady(subject: string, olderNodes: string[], indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.BM25_NOT_READY,
    `${subject} ${olderNodes.length} node(s) below specification version ${BM25_TUNING_SPEC_VERSION}, which cannot use BM25 parameters that the index or the search sets. Try again once every node registers that version`,
    { indexName, nodeIds: olderNodes.sort(), minimumVersion: BM25_TUNING_SPEC_VERSION },
  )
}

export function registeredNodesBelowBm25Tuning(nodes: readonly NodeRegistration[]): string[] {
  return nodes.filter(node => !reachesVersion(node.version, BM25_TUNING_SPEC_VERSION)).map(node => node.nodeId)
}

export async function allocationForBm25Query(
  indexName: string,
  table: AllocationTable,
  listNodes: () => Promise<NodeRegistration[]>,
): Promise<AllocationTable> {
  const nodes = await listNodes()
  const versions = new Map(nodes.map(node => [node.nodeId, node.version]))
  const olderNodes = [...copyHoldersOf(table)].filter(
    holder => versions.has(holder) && !reachesVersion(versions.get(holder), BM25_TUNING_SPEC_VERSION),
  )
  if (olderNodes.length > 0) throw bm25NotReady(`Index '${indexName}' has copies on`, olderNodes, indexName)
  const registered = new Set(versions.keys())
  const assignments = new Map<number, PartitionAssignment>()
  for (const [partitionId, assignment] of table.assignments) {
    assignments.set(partitionId, withRegisteredCopies(assignment, registered))
  }
  return { ...table, assignments }
}
