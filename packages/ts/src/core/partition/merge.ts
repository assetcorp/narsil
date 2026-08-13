import { ErrorCodes, NarsilError } from '../../errors'
import { createGeoIndex } from '../../geo/geo-index'
import { createBooleanIndex, createEnumIndex, createNumericIndex } from '../field-index'
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
    const list = source.invertedIdx.lookup(token)
    if (list === undefined) continue
    for (let i = 0; i < list.length; i++) {
      const sourceInternalId = list.docIds[i]
      if (list.deletedDocs.has(sourceInternalId)) continue
      const targetInternalId = idMapping.get(sourceInternalId)
      if (targetInternalId === undefined) continue
      const fieldName = source.fieldNameTable.names[list.fieldNameIndices[i]]
      const fieldNameIndex = getOrCreateFieldNameIndex(target.fieldNameTable, fieldName)
      const positions = list.positions === null ? null : list.positions[i]
      target.invertedIdx.insert(token, targetInternalId, list.termFrequencies[i], fieldNameIndex, positions ?? null)
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

function mergeFieldIndexes(target: PartitionState, source: PartitionState, idMapping: Map<number, number>): void {
  for (const [fieldPath, index] of source.numericIndexes) {
    let targetIndex = target.numericIndexes.get(fieldPath)
    if (targetIndex === undefined) {
      targetIndex = createNumericIndex()
      target.numericIndexes.set(fieldPath, targetIndex)
    }
    for (const entry of index.serialize()) {
      const targetInternalId = idMapping.get(entry.docId)
      if (targetInternalId === undefined) continue
      targetIndex.insert(targetInternalId, entry.value)
    }
  }

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
}

export function mergeSegmentState(target: PartitionState, source: PartitionState): void {
  if (source.stats.totalDocuments === 0 && source.docStore.count() === 0) return
  const idMapping = mergeDocuments(target, source)
  mergePostings(target, source, idMapping)
  mergeFieldIndexes(target, source, idMapping)
  mergeStatistics(target, source)
  mergeSurfaceForms(target, source)
  target.sortColumns = null
  target.scoreBuffer = null
}
