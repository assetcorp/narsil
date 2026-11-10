import { projectionKeepsField, type ResolvedProjection } from '../../core/projection'
import type { PartitionManager } from '../../partitioning/manager'
import { setNestedValue } from '../../partitioning/manager/nested-values'
import type { StatePin } from '../../partitioning/manager/state-pins'
import type { AnyDocument } from '../../types/schema'
import type { VectorSearcher } from '../../vector/vector-index'
import type { OrdinalAdmission } from '../../vector/vector-store/admission'

function admittedSearcher(searcher: VectorSearcher, admission: OrdinalAdmission | undefined): VectorSearcher {
  return {
    fieldName: searcher.fieldName,
    dimension: searcher.dimension,
    partitionsKnown: () => searcher.partitionsKnown(),
    assignPartitions: resolve => searcher.assignPartitions(resolve),
    searchParallel(query, k, options) {
      const pinned = admission === undefined ? options : { ...options, admission }
      return searcher.searchParallel(query, k, pinned)
    },
  }
}

export function admittedSearchers(
  searchers: ReadonlyMap<string, VectorSearcher>,
  admissions: ReadonlyMap<string, OrdinalAdmission>,
): ReadonlyMap<string, VectorSearcher> {
  const admitted = new Map<string, VectorSearcher>()
  for (const [fieldPath, searcher] of searchers) {
    admitted.set(fieldPath, admittedSearcher(searcher, admissions.get(fieldPath)))
  }
  return admitted
}

type HeldVectorFill = (document: AnyDocument, docId: string, projection: ResolvedProjection | undefined) => void

function pinWithHeldVectors(pin: StatePin, fill: HeldVectorFill): StatePin {
  return {
    get changed() {
      return pin.changed
    },
    has: docId => pin.has(docId),
    partitionIdOf: docId => pin.partitionIdOf(docId),
    getRef: docId => pin.getRef(docId),
    fieldValues: (docId, fieldPaths) => pin.fieldValues(docId, fieldPaths),
    storedFields: (docId, fieldPaths) => pin.storedFields(docId, fieldPaths),
    sortValues: (docId, fields, fieldTypes, modes) => pin.sortValues(docId, fields, fieldTypes, modes),
    release: () => pin.release(),
    get(docId, projection) {
      const document = pin.get(docId, projection)
      if (document !== undefined) fill(document, docId, projection)
      return document
    },
    vectorsInto: fill,
  }
}

export function managerWithHeldVectors(
  manager: PartitionManager,
  fieldPaths: readonly string[],
  vectorOf: (fieldPath: string, docId: string) => Float32Array | undefined,
): PartitionManager {
  const fill: HeldVectorFill = (document, docId, projection) => {
    for (const fieldPath of fieldPaths) {
      if (projection !== undefined && !projectionKeepsField(projection, fieldPath)) continue
      const vector = vectorOf(fieldPath, docId)
      if (vector !== undefined)
        setNestedValue(document as Record<string, unknown>, fieldPath, Float32Array.from(vector))
    }
  }

  const reader: PartitionManager = Object.create(manager)
  reader.get = (docId, projection) => {
    const document = manager.get(docId, projection)
    if (document !== undefined) fill(document, docId, projection)
    return document
  }
  reader.pinState = reads => pinWithHeldVectors(manager.pinState(reads), fill)
  return reader
}
