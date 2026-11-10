import { cloneProjected } from '../../core/projection'
import { documentStoredFields } from '../../core/stored-values/references'
import {
  documentFieldValues,
  documentSortValues,
  type HitReads,
  type StatePin,
} from '../../partitioning/manager/state-pins'
import type { AnyDocument } from '../../types/schema'

export function copyReads(documents: ReadonlyMap<string, AnyDocument>, pin: StatePin): HitReads {
  return {
    get(docId, projection) {
      const ref = documents.get(docId)
      if (ref === undefined) return pin.get(docId, projection)
      const document = cloneProjected(ref, projection)
      pin.vectorsInto(document, docId, projection)
      return document
    },
    getRef(docId) {
      return documents.get(docId) ?? pin.getRef(docId)
    },
    fieldValues(docId, fieldPaths) {
      const ref = documents.get(docId)
      return ref === undefined ? pin.fieldValues(docId, fieldPaths) : documentFieldValues(ref, fieldPaths)
    },
    storedFields(docId, fieldPaths) {
      const ref = documents.get(docId)
      return ref === undefined ? pin.storedFields(docId, fieldPaths) : documentStoredFields(ref, fieldPaths)
    },
    sortValues(docId, fields, fieldTypes, modes) {
      const ref = documents.get(docId)
      return ref === undefined
        ? pin.sortValues(docId, fields, fieldTypes, modes)
        : documentSortValues(ref, fields, modes)
    },
  }
}

export function documentsOf(pin: StatePin, docIds: Iterable<string>): Map<string, AnyDocument> {
  const documents = new Map<string, AnyDocument>()
  for (const docId of docIds) {
    const ref = pin.getRef(docId)
    if (ref !== undefined) documents.set(docId, ref)
  }
  return documents
}
