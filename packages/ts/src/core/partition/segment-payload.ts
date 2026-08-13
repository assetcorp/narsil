import { ErrorCodes, NarsilError } from '../../errors'
import { createGeoIndex } from '../../geo/geo-index'
import type { SerializedSurfaceForms } from '../../types/internal'
import type { AnyDocument } from '../../types/schema'
import { createBooleanIndex, createEnumIndex, createNumericIndex } from '../field-index'
import { getOrCreateFieldNameIndex, type PartitionState } from './utils'

export interface SegmentPayload {
  documentCount: number
  docIds: string[]
  fieldNames: string[]
  tokens: string[]
  postingOffsets: Uint32Array
  postingDocIds: Uint32Array
  postingFrequencies: Uint16Array
  postingFieldIndices: Uint8Array
  positionOffsets: Uint32Array | null
  positionValues: Uint32Array | null
  fieldLengthNames: string[]
  fieldLengthColumns: Uint32Array[]
  totalFieldLengths: Record<string, number>
  docFrequencies: Record<string, number>
  surfaceForms: SerializedSurfaceForms | null
  numeric: Array<{ fieldPath: string; docIds: Uint32Array; values: Float64Array }>
  boolean: Array<{ fieldPath: string; trueDocs: Uint32Array; falseDocs: Uint32Array }>
  enums: Array<{ fieldPath: string; values: string[]; offsets: Uint32Array; docIds: Uint32Array }>
  geo: Array<{ fieldPath: string; docIds: Uint32Array; latitudes: Float64Array; longitudes: Float64Array }>
}

function collectBuffer(buffers: ArrayBuffer[], view: ArrayBufferView | null): void {
  if (view === null) return
  if (view.buffer instanceof ArrayBuffer) buffers.push(view.buffer)
}

export function segmentTransferables(payload: SegmentPayload): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = []
  collectBuffer(buffers, payload.postingOffsets)
  collectBuffer(buffers, payload.postingDocIds)
  collectBuffer(buffers, payload.postingFrequencies)
  collectBuffer(buffers, payload.postingFieldIndices)
  collectBuffer(buffers, payload.positionOffsets)
  collectBuffer(buffers, payload.positionValues)
  for (const column of payload.fieldLengthColumns) collectBuffer(buffers, column)
  for (const entry of payload.numeric) {
    collectBuffer(buffers, entry.docIds)
    collectBuffer(buffers, entry.values)
  }
  for (const entry of payload.boolean) {
    collectBuffer(buffers, entry.trueDocs)
    collectBuffer(buffers, entry.falseDocs)
  }
  for (const entry of payload.enums) {
    collectBuffer(buffers, entry.offsets)
    collectBuffer(buffers, entry.docIds)
  }
  for (const entry of payload.geo) {
    collectBuffer(buffers, entry.docIds)
    collectBuffer(buffers, entry.latitudes)
    collectBuffer(buffers, entry.longitudes)
  }
  return buffers
}

function countPostings(state: PartitionState): { postings: number; positions: number; hasPositions: boolean } {
  let postings = 0
  let positions = 0
  let hasPositions = false
  for (const token of state.invertedIdx.tokens()) {
    const list = state.invertedIdx.lookup(token)
    if (list === undefined) continue
    for (let i = 0; i < list.length; i++) {
      if (list.deletedDocs.has(list.docIds[i])) continue
      postings++
      if (list.positions !== null) {
        hasPositions = true
        positions += list.positions[i]?.length ?? 0
      }
    }
  }
  return { postings, positions, hasPositions }
}

function encodeFieldLengths(
  state: PartitionState,
  documentCount: number,
): {
  names: string[]
  columns: Uint32Array[]
} {
  const names: string[] = []
  const columns: Uint32Array[] = []
  for (const fieldName of Object.keys(state.stats.totalFieldLengths)) {
    const column = state.docStore.fieldLengthColumn(fieldName)
    if (column === null) continue
    names.push(fieldName)
    columns.push(column.slice(0, documentCount))
  }
  return { names, columns }
}

function encodeFieldIndexes(state: PartitionState): Pick<SegmentPayload, 'numeric' | 'boolean' | 'enums' | 'geo'> {
  const numeric: SegmentPayload['numeric'] = []
  for (const [fieldPath, index] of state.numericIndexes) {
    const entries = index.serialize()
    const docIds = new Uint32Array(entries.length)
    const values = new Float64Array(entries.length)
    for (let i = 0; i < entries.length; i++) {
      docIds[i] = entries[i].docId
      values[i] = entries[i].value
    }
    numeric.push({ fieldPath, docIds, values })
  }

  const booleans: SegmentPayload['boolean'] = []
  for (const [fieldPath, index] of state.booleanIndexes) {
    const { trueDocs, falseDocs } = index.serialize()
    booleans.push({ fieldPath, trueDocs: Uint32Array.from(trueDocs), falseDocs: Uint32Array.from(falseDocs) })
  }

  const enums: SegmentPayload['enums'] = []
  for (const [fieldPath, index] of state.enumIndexes) {
    const serialized = index.serialize()
    const values = Object.keys(serialized)
    const offsets = new Uint32Array(values.length + 1)
    let total = 0
    for (let i = 0; i < values.length; i++) {
      total += serialized[values[i]].length
      offsets[i + 1] = total
    }
    const docIds = new Uint32Array(total)
    let cursor = 0
    for (const value of values) {
      for (const docId of serialized[value]) docIds[cursor++] = docId
    }
    enums.push({ fieldPath, values, offsets, docIds })
  }

  const geo: SegmentPayload['geo'] = []
  for (const [fieldPath, index] of state.geoIndexes) {
    const entries = index.serialize()
    const docIds = new Uint32Array(entries.length)
    const latitudes = new Float64Array(entries.length)
    const longitudes = new Float64Array(entries.length)
    for (let i = 0; i < entries.length; i++) {
      docIds[i] = entries[i].docId
      latitudes[i] = entries[i].lat
      longitudes[i] = entries[i].lon
    }
    geo.push({ fieldPath, docIds, latitudes, longitudes })
  }

  return { numeric, boolean: booleans, enums, geo }
}

export function encodeSegmentState(state: PartitionState): SegmentPayload {
  const documentCount = state.docStore.count()
  const docIds: string[] = []
  for (const internalId of state.docStore.allInternalIds()) {
    docIds.push(state.docStore.getExternalId(internalId) ?? '')
  }

  const { postings, positions, hasPositions } = countPostings(state)
  const tokens: string[] = []
  const postingOffsets = new Uint32Array(state.invertedIdx.size() + 1)
  const postingDocIds = new Uint32Array(postings)
  const postingFrequencies = new Uint16Array(postings)
  const postingFieldIndices = new Uint8Array(postings)
  const positionOffsets = hasPositions ? new Uint32Array(postings + 1) : null
  const positionValues = hasPositions ? new Uint32Array(positions) : null

  let postingCursor = 0
  let positionCursor = 0
  for (const token of state.invertedIdx.tokens()) {
    const list = state.invertedIdx.lookup(token)
    if (list === undefined) continue
    tokens.push(token)
    for (let i = 0; i < list.length; i++) {
      const internalId = list.docIds[i]
      if (list.deletedDocs.has(internalId)) continue
      postingDocIds[postingCursor] = internalId
      postingFrequencies[postingCursor] = list.termFrequencies[i]
      postingFieldIndices[postingCursor] = list.fieldNameIndices[i]
      if (positionOffsets !== null && positionValues !== null) {
        positionOffsets[postingCursor] = positionCursor
        const entryPositions = list.positions === null ? null : list.positions[i]
        if (entryPositions !== null && entryPositions !== undefined) {
          for (const position of entryPositions) positionValues[positionCursor++] = position
        }
      }
      postingCursor++
    }
    postingOffsets[tokens.length] = postingCursor
  }
  if (positionOffsets !== null) positionOffsets[postingCursor] = positionCursor

  const fieldLengths = encodeFieldLengths(state, documentCount)

  return {
    documentCount,
    docIds,
    fieldNames: [...state.fieldNameTable.names],
    tokens,
    postingOffsets: postingOffsets.slice(0, tokens.length + 1),
    postingDocIds,
    postingFrequencies,
    postingFieldIndices,
    positionOffsets,
    positionValues,
    fieldLengthNames: fieldLengths.names,
    fieldLengthColumns: fieldLengths.columns,
    totalFieldLengths: { ...state.stats.totalFieldLengths },
    docFrequencies: { ...state.stats.docFrequencies },
    surfaceForms: state.surfaceRegistry.size() === 0 ? null : state.surfaceRegistry.serialize(),
    ...encodeFieldIndexes(state),
  }
}

function mergePayloadPostings(target: PartitionState, payload: SegmentPayload, ordinalBase: number): void {
  const fieldNameIndices = payload.fieldNames.map(name => getOrCreateFieldNameIndex(target.fieldNameTable, name))
  const { postingOffsets, postingDocIds, postingFrequencies, postingFieldIndices } = payload
  const { positionOffsets, positionValues } = payload

  for (let t = 0; t < payload.tokens.length; t++) {
    const token = payload.tokens[t]
    const end = postingOffsets[t + 1]
    for (let p = postingOffsets[t]; p < end; p++) {
      let positions: number[] | null = null
      if (positionOffsets !== null && positionValues !== null) {
        const start = positionOffsets[p]
        const stop = positionOffsets[p + 1]
        if (stop > start) {
          positions = new Array(stop - start)
          for (let i = start; i < stop; i++) positions[i - start] = positionValues[i]
        } else {
          positions = []
        }
      }
      target.invertedIdx.insert(
        token,
        ordinalBase + postingDocIds[p],
        postingFrequencies[p],
        fieldNameIndices[postingFieldIndices[p]],
        positions,
      )
    }
  }
}

function mergePayloadFieldIndexes(target: PartitionState, payload: SegmentPayload, ordinalBase: number): void {
  for (const entry of payload.numeric) {
    let index = target.numericIndexes.get(entry.fieldPath)
    if (index === undefined) {
      index = createNumericIndex()
      target.numericIndexes.set(entry.fieldPath, index)
    }
    for (let i = 0; i < entry.docIds.length; i++) index.insert(ordinalBase + entry.docIds[i], entry.values[i])
  }

  for (const entry of payload.boolean) {
    let index = target.booleanIndexes.get(entry.fieldPath)
    if (index === undefined) {
      index = createBooleanIndex()
      target.booleanIndexes.set(entry.fieldPath, index)
    }
    for (const docId of entry.trueDocs) index.insert(ordinalBase + docId, true)
    for (const docId of entry.falseDocs) index.insert(ordinalBase + docId, false)
  }

  for (const entry of payload.enums) {
    let index = target.enumIndexes.get(entry.fieldPath)
    if (index === undefined) {
      index = createEnumIndex()
      target.enumIndexes.set(entry.fieldPath, index)
    }
    for (let v = 0; v < entry.values.length; v++) {
      const end = entry.offsets[v + 1]
      for (let i = entry.offsets[v]; i < end; i++) index.insert(ordinalBase + entry.docIds[i], entry.values[v])
    }
  }

  for (const entry of payload.geo) {
    let index = target.geoIndexes.get(entry.fieldPath)
    if (index === undefined) {
      index = createGeoIndex()
      target.geoIndexes.set(entry.fieldPath, index)
    }
    for (let i = 0; i < entry.docIds.length; i++) {
      index.insert(ordinalBase + entry.docIds[i], entry.latitudes[i], entry.longitudes[i])
    }
  }
}

export function mergeSegmentPayload(
  target: PartitionState,
  payload: SegmentPayload,
  documents: ReadonlyArray<AnyDocument>,
): void {
  if (payload.documentCount === 0) return

  const ordinalBase = target.docStore.internalIdCapacity()
  for (let i = 0; i < payload.docIds.length; i++) {
    const fieldLengths: Record<string, number> = {}
    for (let f = 0; f < payload.fieldLengthNames.length; f++) {
      const length = payload.fieldLengthColumns[f][i]
      if (length > 0) fieldLengths[payload.fieldLengthNames[f]] = length
    }
    const docId = payload.docIds[i]
    if (target.docStore.has(docId)) {
      throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${docId}" already exists in this partition`, {
        docId,
      })
    }
    target.docStore.storeRef(docId, documents[i], fieldLengths)
    if (target.docStore.getInternalId(docId) !== ordinalBase + i) {
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, `Segment ordinals for "${docId}" did not stay contiguous`, {
        docId,
      })
    }
  }

  mergePayloadPostings(target, payload, ordinalBase)
  mergePayloadFieldIndexes(target, payload, ordinalBase)

  target.stats.totalDocuments += payload.documentCount
  for (const [fieldName, length] of Object.entries(payload.totalFieldLengths)) {
    target.stats.totalFieldLengths[fieldName] = (target.stats.totalFieldLengths[fieldName] ?? 0) + length
  }
  for (const [token, frequency] of Object.entries(payload.docFrequencies)) {
    target.stats.docFrequencies[token] = (target.stats.docFrequencies[token] ?? 0) + frequency
  }
  target.stats.recalculateAverages()

  if (payload.surfaceForms !== null) {
    for (const surface of Object.keys(payload.surfaceForms)) {
      const value = payload.surfaceForms[surface]
      if (!Array.isArray(value)) continue
      target.surfaceRegistry.add(surface, value[1], value[0])
    }
  }

  target.sortColumns = null
  target.scoreBuffer = null
}
