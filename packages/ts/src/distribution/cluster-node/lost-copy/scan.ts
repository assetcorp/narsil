import { getIndexMetadata } from '../../cluster/index-metadata'
import { lastHoldersOf } from '../../cluster/last-holders'
import { belongsToAnotherIndex } from '../../cluster/table-identity'
import type { ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import { type LocalHoldings, partitionsWithoutCopy } from './holdings'

export interface MissingCopy {
  indexName: string
  indexUuid: string
  partitionId: number
}

export interface CopyScan {
  missing: MissingCopy[]
  failure: { error: unknown } | null
}

export interface CopyScanDeps extends LocalHoldings {
  nodeId: string
  coordinator: ClusterCoordinator
}

function needsCopy(assignment: PartitionAssignment, nodeId: string): boolean {
  if (assignment.primary !== nodeId && !assignment.inSyncSet.includes(nodeId)) return false
  if (assignment.state === 'UNASSIGNED') return false
  return assignment.state !== 'INITIALISING' || lastHoldersOf(assignment).length > 0
}

async function missingOfIndex(deps: CopyScanDeps, indexName: string): Promise<MissingCopy[]> {
  const { coordinator, nodeId } = deps
  const table = await coordinator.getAllocation(indexName)
  if (table === null) return []
  const assigned: number[] = []
  for (const [partitionId, assignment] of table.assignments) {
    if (needsCopy(assignment, nodeId)) assigned.push(partitionId)
  }
  if (assigned.length === 0) return []

  const metadata = await getIndexMetadata(coordinator, indexName)
  if (metadata === null || belongsToAnotherIndex(table, metadata.indexUuid)) return []
  if ((await coordinator.getSchema(indexName)) === null) return []

  const { indexUuid } = metadata
  const lacking = await partitionsWithoutCopy(deps, indexName, indexUuid, assigned)
  return lacking.map(partitionId => ({ indexName, indexUuid, partitionId }))
}

export async function scanForMissingCopies(deps: CopyScanDeps): Promise<CopyScan> {
  const scan: CopyScan = { missing: [], failure: null }
  let indexNames: string[]
  try {
    indexNames = await deps.coordinator.listSchemas()
  } catch (error) {
    scan.failure = { error }
    return scan
  }
  for (const indexName of indexNames) {
    try {
      scan.missing.push(...(await missingOfIndex(deps, indexName)))
    } catch (error) {
      scan.failure ??= { error }
    }
  }
  return scan
}
