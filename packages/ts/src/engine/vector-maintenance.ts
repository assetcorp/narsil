import { ErrorCodes, NarsilError } from '../errors'
import type { PartitionManager } from '../partitioning/manager'
import type { VectorMaintenanceResult } from '../types/results'
import type { VectorIndex } from '../vector/vector-index'

function resolveVectorIndexes(
  manager: PartitionManager,
  indexName: string,
  fieldName: string | undefined,
): Map<string, VectorIndex> {
  const all = manager.getVectorIndexes()
  if (fieldName === undefined) return all

  const idx = all.get(fieldName)
  if (!idx) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Vector field "${fieldName}" not found in index "${indexName}"`, {
      indexName,
      fieldName,
    })
  }

  const single = new Map<string, VectorIndex>()
  single.set(fieldName, idx)
  return single
}

export function compactVectors(manager: PartitionManager, indexName: string, fieldName?: string): void {
  const indexes = resolveVectorIndexes(manager, indexName, fieldName)
  for (const [, idx] of indexes) {
    idx.compact()
  }
}

export async function optimizeVectors(manager: PartitionManager, indexName: string, fieldName?: string): Promise<void> {
  const indexes = resolveVectorIndexes(manager, indexName, fieldName)
  for (const [, idx] of indexes) {
    await idx.optimize()
  }
}

export function getVectorMaintenanceStatus(manager: PartitionManager): VectorMaintenanceResult[] {
  const indexes = manager.getVectorIndexes()
  const results: VectorMaintenanceResult[] = []
  for (const [field, idx] of indexes) {
    const status = idx.maintenanceStatus()
    results.push({
      fieldName: field,
      tombstoneRatio: status.tombstoneRatio,
      graphCount: status.graphCount,
      bufferSize: status.bufferSize,
      building: status.building,
      estimatedCompactMs: status.estimatedCompactMs,
      estimatedOptimizeMs: status.estimatedOptimizeMs,
    })
  }
  return results
}
