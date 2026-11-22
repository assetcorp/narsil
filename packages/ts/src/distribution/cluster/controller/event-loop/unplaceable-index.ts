import { ErrorCodes, NarsilError } from '../../../../errors'
import type { AllocationTable, ClusterCoordinator } from '../../../coordinator/types'
import { assignmentsWithoutDepartedNodes } from '../../allocator/departed-nodes'
import { ALLOCATION_CAS_ATTEMPTS } from '../../constants'
import { putAllocationOver } from '../../in-sync-version'
import { getIndexMetadata } from '../../index-metadata'
import { belongsToAnotherIndex, stampedWith } from '../../table-identity'

export async function failOverWithoutPlacement(
  coordinator: ClusterCoordinator,
  writerNodeId: string,
  indexName: string,
  registeredNodeIds: ReadonlySet<string>,
  isActive: () => boolean,
  retainedFor: (table: AllocationTable) => ReadonlySet<string>,
): Promise<void> {
  for (let attempt = 0; attempt < ALLOCATION_CAS_ATTEMPTS; attempt++) {
    const table = await coordinator.getAllocation(indexName)
    if (table === null || table.generation !== undefined || !isActive()) return
    const metadata = await getIndexMetadata(coordinator, indexName)
    if (metadata === null || belongsToAnotherIndex(table, metadata.indexUuid)) return
    const assignments = assignmentsWithoutDepartedNodes(table.assignments, registeredNodeIds, retainedFor(table))
    if (assignments === null || !isActive()) return
    const next = stampedWith({ ...table, version: table.version + 1, assignments }, metadata.indexUuid)
    if (await putAllocationOver(coordinator, indexName, table, next, writerNodeId)) return
  }

  throw new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `Allocation for index '${indexName}' lost ${ALLOCATION_CAS_ATTEMPTS} compare-and-set attempts`,
    { indexName, attempts: ALLOCATION_CAS_ATTEMPTS },
  )
}
