import { projectionKeepsField, type ResolvedProjection } from '../../core/projection'
import type { PartitionManager } from '../../partitioning/manager'
import { setNestedValue } from '../../partitioning/manager/nested-values'
import type { AnyDocument } from '../../types/schema'

export function managerWithHeldVectors(
  manager: PartitionManager,
  fieldPaths: readonly string[],
  vectorOf: (fieldPath: string, docId: string) => Float32Array | undefined,
): PartitionManager {
  function get(docId: string, projection?: ResolvedProjection): AnyDocument | undefined {
    const document = manager.get(docId, projection)
    if (document === undefined) return undefined
    for (const fieldPath of fieldPaths) {
      if (projection !== undefined && !projectionKeepsField(projection, fieldPath)) continue
      const vector = vectorOf(fieldPath, docId)
      if (vector !== undefined)
        setNestedValue(document as Record<string, unknown>, fieldPath, Float32Array.from(vector))
    }
    return document
  }

  const reader: PartitionManager = Object.create(manager)
  reader.get = get
  return reader
}
