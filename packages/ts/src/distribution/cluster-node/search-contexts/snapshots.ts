import type { PartitionManager } from '../../../partitioning/manager/types'
import type { QueryResult } from '../../../types/results'

export interface DocumentSnapshot {
  readonly fields: Readonly<Record<string, unknown>>
  readonly vectors: ReadonlyArray<readonly [string, Float32Array]>
}

function snapshotOf(manager: PartitionManager, docId: string): DocumentSnapshot | undefined {
  const fields = manager.getRef(docId)
  if (fields === undefined) return undefined
  const vectors: Array<readonly [string, Float32Array]> = []
  for (const [fieldPath, vectorIndex] of manager.getVectorIndexes()) {
    const vector = vectorIndex.getVector(docId)
    if (vector !== null) vectors.push([fieldPath, vector])
  }
  return { fields: fields as Readonly<Record<string, unknown>>, vectors }
}

export function snapshotRankedDocuments(
  manager: PartitionManager,
  result: QueryResult<unknown>,
  into: Map<string, DocumentSnapshot>,
): void {
  const take = (docId: string): void => {
    if (into.has(docId)) return
    const snapshot = snapshotOf(manager, docId)
    if (snapshot !== undefined) into.set(docId, snapshot)
  }
  for (const hit of result.hits) take(hit.id)
  for (const group of result.groups ?? []) {
    for (const hit of group.hits) take(hit.id)
  }
}
