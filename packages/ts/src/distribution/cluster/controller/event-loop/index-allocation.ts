import { ErrorCodes, NarsilError } from '../../../../errors'
import type { AllocationTable, ClusterCoordinator, NodeRegistration } from '../../../coordinator/types'
import type { NodeTransport } from '../../../transport/types'
import { allocate } from '../../allocator/index'
import { ALLOCATION_CAS_ATTEMPTS } from '../../constants'
import { putAllocationOver } from '../../in-sync-version'
import { getIndexMetadata } from '../../index-metadata'
import { belongsToAnotherIndex, stampedWith } from '../../table-identity'
import { handOverLeads, type LeadHandoffContext, type LeadMove, liftHandoffs } from './lead-handoff'

export type RetainedNodes = (table: AllocationTable) => ReadonlySet<string>

export const RETAIN_NONE: RetainedNodes = () => new Set()

export interface IndexAllocationRun {
  coordinator: ClusterCoordinator
  writerNodeId: string
  transport: NodeTransport | null
  indexName: string
  nodes: NodeRegistration[]
  isActive: () => boolean
  retainedFor?: RetainedNodes
}

async function allocateIndex(run: IndexAllocationRun, handoffs: LeadHandoffContext, held: LeadMove[]) {
  const { coordinator, writerNodeId, indexName, nodes, isActive } = run
  const retainedFor = run.retainedFor ?? RETAIN_NONE
  for (let attempt = 0; attempt < ALLOCATION_CAS_ATTEMPTS; attempt++) {
    if (!isActive()) return false
    const storedTable = await coordinator.getAllocation(indexName)
    if (!isActive()) return false
    const metadata = await getIndexMetadata(coordinator, indexName)
    if (metadata === null || !isActive()) return false
    const currentTable =
      storedTable !== null && belongsToAnotherIndex(storedTable, metadata.indexUuid) ? null : storedTable
    if (currentTable?.generation !== undefined) return false
    if (currentTable === null && ((await coordinator.getSchema(indexName)) === null || !isActive())) return false
    const result = allocate(
      nodes,
      currentTable,
      indexName,
      metadata.partitionCount,
      metadata.replicationFactor,
      metadata.constraints,
      currentTable === null ? undefined : retainedFor(currentTable),
    )
    const handedOver = await handOverLeads(handoffs, currentTable, result.table, held)
    if (!isActive()) return false
    const table = stampedWith(handedOver, metadata.indexUuid)
    if (await putAllocationOver(coordinator, indexName, storedTable, table, writerNodeId)) return true
  }
  throw new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `Allocation for index '${indexName}' lost ${ALLOCATION_CAS_ATTEMPTS} compare-and-set attempts`,
    { indexName, attempts: ALLOCATION_CAS_ATTEMPTS },
  )
}

export async function runAllocatorForIndex(run: IndexAllocationRun): Promise<void> {
  const handoffs: LeadHandoffContext = {
    transport: run.transport,
    senderId: run.writerNodeId,
    indexName: run.indexName,
    nodes: run.nodes,
  }
  const held: LeadMove[] = []
  let written = false
  try {
    written = await allocateIndex(run, handoffs, held)
  } finally {
    if (!written) await liftHandoffs(handoffs, held)
  }
}
