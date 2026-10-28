import { ErrorCodes, NarsilError } from '../../errors'
import { createGeoIndex } from '../../geo/geo-index'
import { createBooleanIndex, createEnumIndex, createNumericIndex, type NumericFieldIndex } from '../field-index'
import { patternIndexOf } from '../pattern-index/host'
import { getOrCreateFieldNameIndex, type PartitionState } from './utils'

function mergeDocuments(target: PartitionState, source: PartitionState): Map<number, number> {
  const idMapping = new Map<number, number>()
  for (const sourceInternalId of source.docStore.allInternalIds()) {
    const docId = source.docStore.getExternalId(sourceInternalId)
    if (docId === undefined) continue
    const stored = source.docStore.get(docId)
    if (stored === undefined) continue
    if (target.docStore.has(docId)) {
      throw new NarsilError(
        ErrorCodes.DOC_ALREADY_EXISTS,
        `Document "${docId}" appears in more than one segment of the same batch`,
        { docId },
      )
    }
    target.docStore.storeRef(docId, stored.fields, stored.fieldLengths)
    const targetInternalId = target.docStore.getInternalId(docId)
    if (targetInternalId === undefined) continue
    idMapping.set(sourceInternalId, targetInternalId)
  }
  return idMapping
}

function mergePostings(target: PartitionState, source: PartitionState, idMapping: Map<number, number>): void {
  for (const token of source.invertedIdx.tokens()) {
    const list = source.invertedIdx.lookupReadOnce?.(token) ?? source.invertedIdx.lookup(token)
    if (list === undefined) continue
    const { docIds, termFrequencies, fieldNameIndices, deletedDocs, positions, length } = list
    for (let i = 0; i < length; i++) {
      const sourceInternalId = docIds[i]
      if (deletedDocs.has(sourceInternalId)) continue
      const targetInternalId = idMapping.get(sourceInternalId)
      if (targetInternalId === undefined) continue
      const fieldName = source.fieldNameTable.names[fieldNameIndices[i]]
      const fieldNameIndex = getOrCreateFieldNameIndex(target.fieldNameTable, fieldName)
      const entryPositions = positions === null ? null : positions[i]
      target.invertedIdx.insert(token, targetInternalId, termFrequencies[i], fieldNameIndex, entryPositions ?? null)
    }
  }
}

function mergeStatistics(target: PartitionState, source: PartitionState): void {
  target.stats.totalDocuments += source.stats.totalDocuments
  for (const [fieldName, length] of Object.entries(source.stats.totalFieldLengths)) {
    target.stats.totalFieldLengths[fieldName] = (target.stats.totalFieldLengths[fieldName] ?? 0) + length
  }
  for (const [token, frequency] of Object.entries(source.stats.docFrequencies)) {
    target.stats.docFrequencies[token] = (target.stats.docFrequencies[token] ?? 0) + frequency
  }
  target.stats.recalculateAverages()
}

function mergeSurfaceForms(target: PartitionState, source: PartitionState): void {
  const serialized = source.surfaceRegistry.serialize()
  for (const surface of Object.keys(serialized)) {
    const value = serialized[surface]
    if (!Array.isArray(value)) continue
    target.surfaceRegistry.add(surface, value[1], value[0])
  }
}

function mergeNumericIndexes(
  target: Map<string, NumericFieldIndex>,
  source: ReadonlyMap<string, NumericFieldIndex>,
  idMapping: Map<number, number>,
): void {
  for (const [fieldPath, index] of source) {
    let targetIndex = target.get(fieldPath)
    if (targetIndex === undefined) {
      targetIndex = createNumericIndex()
      target.set(fieldPath, targetIndex)
    }
    for (const entry of index.serialize()) {
      const targetInternalId = idMapping.get(entry.docId)
      if (targetInternalId === undefined) continue
      targetIndex.insert(targetInternalId, entry.value)
    }
  }
}

function mergeFieldIndexes(target: PartitionState, source: PartitionState, idMapping: Map<number, number>): void {
  mergeNumericIndexes(target.numericIndexes, source.numericIndexes, idMapping)
  mergeNumericIndexes(target.sizeIndexes, source.sizeIndexes, idMapping)

  for (const [fieldPath, index] of source.booleanIndexes) {
    let targetIndex = target.booleanIndexes.get(fieldPath)
    if (targetIndex === undefined) {
      targetIndex = createBooleanIndex()
      target.booleanIndexes.set(fieldPath, targetIndex)
    }
    const { trueDocs, falseDocs } = index.serialize()
    for (const sourceInternalId of trueDocs) {
      const targetInternalId = idMapping.get(sourceInternalId)
      if (targetInternalId !== undefined) targetIndex.insert(targetInternalId, true)
    }
    for (const sourceInternalId of falseDocs) {
      const targetInternalId = idMapping.get(sourceInternalId)
      if (targetInternalId !== undefined) targetIndex.insert(targetInternalId, false)
    }
  }

  for (const [fieldPath, index] of source.enumIndexes) {
    let targetIndex = target.enumIndexes.get(fieldPath)
    if (targetIndex === undefined) {
      targetIndex = createEnumIndex()
      target.enumIndexes.set(fieldPath, targetIndex)
    }
    for (const [value, docIds] of Object.entries(index.serialize())) {
      for (const sourceInternalId of docIds) {
        const targetInternalId = idMapping.get(sourceInternalId)
        if (targetInternalId !== undefined) targetIndex.insert(targetInternalId, value)
      }
    }
  }

  for (const [fieldPath, index] of source.geoIndexes) {
    let targetIndex = target.geoIndexes.get(fieldPath)
    if (targetIndex === undefined) {
      targetIndex = createGeoIndex()
      target.geoIndexes.set(fieldPath, targetIndex)
    }
    for (const entry of index.serialize()) {
      const targetInternalId = idMapping.get(entry.docId)
      if (targetInternalId === undefined) continue
      targetIndex.insert(targetInternalId, entry.lat, entry.lon)
    }
  }

  for (const [fieldPath, index] of source.patternIndexes) {
    patternIndexOf(target.patternIndexes, fieldPath).addArrays(
      index.toArrays(fieldPath, null),
      sourceInternalId => idMapping.get(sourceInternalId) ?? -1,
    )
  }
}

export function mergeSegmentState(target: PartitionState, source: PartitionState): void {
  if (source.stats.totalDocuments === 0 && source.docStore.count() === 0) return
  const idMapping = mergeDocuments(target, source)
  mergePostings(target, source, idMapping)
  mergeFieldIndexes(target, source, idMapping)
  mergeStatistics(target, source)
  mergeSurfaceForms(target, source)
  target.partialWords.afterMerge(source.partialWords.spellings(), [...idMapping.values()])
  target.sortColumns = null
  target.scoreBuffer = null
}
