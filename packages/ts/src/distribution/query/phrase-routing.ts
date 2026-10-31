import { ErrorCodes, NarsilError } from '../../errors'
import { holdsQuotedText } from '../../search/phrases'
import { PHRASE_SEARCH_SPEC_VERSION, reachesVersion } from '../cluster/version'
import type { AllocationTable, PartitionAssignment } from '../coordinator/types'
import type { NodeRegistration } from '../coordinator/types/node'
import { copyHoldersOf } from './selection'

export function queryReadsPhrases(term: string | null | undefined): boolean {
  return typeof term === 'string' && holdsQuotedText(term)
}

function withRegisteredCopies(assignment: PartitionAssignment, registered: ReadonlySet<string>): PartitionAssignment {
  return {
    ...assignment,
    primary: assignment.primary !== null && registered.has(assignment.primary) ? assignment.primary : null,
    replicas: assignment.replicas.filter(replica => registered.has(replica)),
  }
}

export async function allocationForPhraseQuery(
  indexName: string,
  table: AllocationTable,
  listNodes: () => Promise<NodeRegistration[]>,
): Promise<AllocationTable> {
  const nodes = await listNodes()
  const versions = new Map(nodes.map(node => [node.nodeId, node.version]))
  const olderNodes = [...copyHoldersOf(table)].filter(
    holder => versions.has(holder) && !reachesVersion(versions.get(holder), PHRASE_SEARCH_SPEC_VERSION),
  )
  if (olderNodes.length > 0) {
    throw new NarsilError(
      ErrorCodes.SEARCH_PHRASE_NOT_READY,
      `Index '${indexName}' has copies on ${olderNodes.length} node(s) below specification version ${PHRASE_SEARCH_SPEC_VERSION}, which cannot match a phrase. Try the query again once every node registers that version`,
      { indexName, nodeIds: olderNodes.sort(), minimumVersion: PHRASE_SEARCH_SPEC_VERSION },
    )
  }
  const registered = new Set(versions.keys())
  const assignments = new Map<number, PartitionAssignment>()
  for (const [partitionId, assignment] of table.assignments) {
    assignments.set(partitionId, withRegisteredCopies(assignment, registered))
  }
  return { ...table, assignments }
}
