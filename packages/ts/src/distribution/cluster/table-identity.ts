import type { AllocationTable, ClusterCoordinator } from '../coordinator/types'
import { getIndexMetadata } from './index-metadata'

export function belongsToAnotherIndex(table: AllocationTable, indexUuid: string | undefined): boolean {
  return table.indexUuid !== undefined && indexUuid !== undefined && table.indexUuid !== indexUuid
}

export function stampedWith(table: AllocationTable, indexUuid: string | undefined): AllocationTable {
  return indexUuid === undefined ? table : { ...table, indexUuid }
}

export async function rewriteForCurrentIndex(
  coordinator: ClusterCoordinator,
  table: AllocationTable,
): Promise<AllocationTable | null> {
  const metadata = await getIndexMetadata(coordinator, table.indexName)
  const indexUuid = metadata?.indexUuid
  if (belongsToAnotherIndex(table, indexUuid)) return null
  return stampedWith(table, indexUuid)
}
