import type { AnyDocument } from '../../../types/schema'
import { generateId } from '../../id-generator'
import { buildPartialWordTableFrom, partialSpellingsOfDocuments } from '../partial-words/registry'
import { type PartialSpellings, type PartialWordAnalysis, sameFields } from '../partial-words/spellings'
import type { PartialWordTableData } from '../partial-words/types'
import type { SegmentPayload } from '../segment-payload'
import type { SegmentColumns } from './columns'
import { type EncodedDocumentTableData, encodeDocumentTableData, storedDocumentsOf } from './document-source'
import { type ExternalIdTableData, encodeExternalIdTableData } from './external-ids'
import { encodeSurfaceTable, type SurfaceTableData } from './surface-table'
import { encodeFrozenTokenTableData, type FrozenTokenTableData, wrapFrozenTokenTable } from './token-table'

export interface SharedSegmentSnapshot extends Omit<SegmentColumns, 'surfaceForms'> {
  segmentId: string
  tokenTable: FrozenTokenTableData
  idTable: ExternalIdTableData
  documentTable: EncodedDocumentTableData
  /** The surface forms packed flat, or null where the segment holds none. */
  surfaceTable: SurfaceTableData | null
  partialWords: PartialWordTableData | null
}

function sharedUint32(source: Uint32Array): Uint32Array {
  const copy = new Uint32Array(new SharedArrayBuffer(source.length * 4))
  copy.set(source)
  return copy
}

function sharedUint16(source: Uint16Array): Uint16Array {
  const copy = new Uint16Array(new SharedArrayBuffer(source.length * 2))
  copy.set(source)
  return copy
}

function sharedUint8(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(new SharedArrayBuffer(source.length))
  copy.set(source)
  return copy
}

function sharedFloat64(source: Float64Array): Float64Array {
  const copy = new Float64Array(new SharedArrayBuffer(source.length * 8))
  copy.set(source)
  return copy
}

function sharedSurfaceTable(payload: SegmentPayload): SurfaceTableData | null {
  if (payload.surfaceForms === null) return null
  const table = encodeSurfaceTable(payload.surfaceForms)
  if (table.counts.length === 0) return null
  return { blob: sharedUint8(table.blob), offsets: sharedUint32(table.offsets), counts: sharedUint32(table.counts) }
}

function sharePartialWordTable(table: PartialWordTableData): PartialWordTableData {
  if (typeof SharedArrayBuffer !== 'function' || table.runEntries.buffer instanceof SharedArrayBuffer) return table
  return {
    fields: [...table.fields],
    spellings: sharedUint8(table.spellings),
    spellingOffsets: sharedUint32(table.spellingOffsets),
    spellingTokens: sharedUint32(table.spellingTokens),
    spellingCounts: sharedUint32(table.spellingCounts),
    runs: sharedUint32(table.runs),
    runOffsets: sharedUint32(table.runOffsets),
    runEntries: sharedUint32(table.runEntries),
  }
}

function sharedPartialWordsOf(
  tokenData: FrozenTokenTableData,
  spellings: PartialSpellings | null,
  documentData: EncodedDocumentTableData,
  analysis: PartialWordAnalysis | null,
): PartialWordTableData | null {
  let source = spellings
  if (source === null && analysis !== null && analysis.fields.length > 0) {
    source = partialSpellingsOfDocuments(storedDocumentsOf(documentData), analysis)
  }
  if (source === null || source.fields.length === 0) return null
  const table = buildPartialWordTableFrom(source, wrapFrozenTokenTable(tokenData))
  return table === null ? null : sharePartialWordTable(table)
}

function partialWordsMatch(table: PartialWordTableData | null, analysis: PartialWordAnalysis | null): boolean {
  if (table === null) return analysis === null || analysis.fields.length === 0
  return analysis === null || sameFields(table.fields, analysis.fields)
}

export type SegmentArraysData = Omit<SharedSegmentSnapshot, 'segmentId'>

export function shareSegmentArrays(
  arrays: SegmentArraysData,
  analysis: PartialWordAnalysis | null,
  segmentId?: string,
): SharedSegmentSnapshot {
  const partialWords = partialWordsMatch(arrays.partialWords, analysis)
    ? arrays.partialWords
    : sharedPartialWordsOf(arrays.tokenTable, null, arrays.documentTable, analysis)
  return { ...arrays, segmentId: segmentId ?? generateId(), partialWords }
}

export function segmentArraysOf(
  payload: SegmentPayload,
  documentData: EncodedDocumentTableData,
  reusedPartialWords: PartialWordTableData | null = null,
): SegmentArraysData {
  const tokenTable = encodeFrozenTokenTableData(payload.tokens, payload.docFrequencies)
  const idTable = encodeExternalIdTableData(payload.docIds)
  const surfaceTable = payload.surfaceForms === null ? null : encodeSurfaceTable(payload.surfaceForms)
  const partialWords =
    reusedPartialWords ??
    (payload.partialSpellings === null
      ? null
      : buildPartialWordTableFrom(payload.partialSpellings, wrapFrozenTokenTable(tokenTable)))
  return {
    documentCount: payload.documentCount,
    fieldNames: payload.fieldNames,
    fieldLengthNames: payload.fieldLengthNames,
    fieldLengthColumns: payload.fieldLengthColumns,
    totalFieldLengths: payload.totalFieldLengths,
    tokenTable,
    idTable,
    documentTable: documentData,
    postingOffsets: payload.postingOffsets,
    postingDocIds: payload.postingDocIds,
    postingFrequencies: payload.postingFrequencies,
    postingFieldIndices: payload.postingFieldIndices,
    positionOffsets: payload.positionOffsets,
    positionValues: payload.positionValues,
    numeric: payload.numeric,
    sizes: payload.sizes,
    boolean: payload.boolean,
    enums: payload.enums,
    geo: payload.geo,
    pattern: payload.pattern,
    surfaceTable: surfaceTable === null || surfaceTable.counts.length === 0 ? null : surfaceTable,
    partialWords,
  }
}

export function freezeSegmentShared(
  payload: SegmentPayload,
  documents: ReadonlyArray<AnyDocument>,
  segmentId?: string,
  analysis: PartialWordAnalysis | null = null,
): SharedSegmentSnapshot | null {
  if (typeof SharedArrayBuffer !== 'function') return null
  return freezeEncodedSegmentShared(payload, encodeDocumentTableData(documents), segmentId, analysis)
}

export function freezeEncodedSegmentShared(
  payload: SegmentPayload,
  documentData: EncodedDocumentTableData,
  segmentId?: string,
  analysis: PartialWordAnalysis | null = null,
  reusedPartialWords: PartialWordTableData | null = null,
): SharedSegmentSnapshot | null {
  if (typeof SharedArrayBuffer !== 'function') return null

  const tokenData = encodeFrozenTokenTableData(payload.tokens, payload.docFrequencies)
  const idData = encodeExternalIdTableData(payload.docIds)

  return {
    segmentId: segmentId ?? generateId(),
    documentCount: payload.documentCount,
    fieldNames: [...payload.fieldNames],
    fieldLengthNames: [...payload.fieldLengthNames],
    fieldLengthColumns: payload.fieldLengthColumns.map(sharedUint32),
    totalFieldLengths: { ...payload.totalFieldLengths },
    tokenTable: {
      blob: sharedUint8(tokenData.blob),
      offsets: sharedUint32(tokenData.offsets),
      payloadSlots: sharedUint32(tokenData.payloadSlots),
      documentFrequencies: sharedUint32(tokenData.documentFrequencies),
    },
    idTable: {
      blob: sharedUint8(idData.blob),
      offsets: sharedUint32(idData.offsets),
      sortedOrdinals: sharedUint32(idData.sortedOrdinals),
    },
    documentTable: {
      blob: sharedUint8(documentData.blob),
      offsets: sharedUint32(documentData.offsets),
      ...(documentData.discardedFields === undefined ? {} : { discardedFields: documentData.discardedFields }),
    },
    postingOffsets: sharedUint32(payload.postingOffsets),
    postingDocIds: sharedUint32(payload.postingDocIds),
    postingFrequencies: sharedUint16(payload.postingFrequencies),
    postingFieldIndices: sharedUint16(payload.postingFieldIndices),
    positionOffsets: payload.positionOffsets === null ? null : sharedUint32(payload.positionOffsets),
    positionValues: payload.positionValues === null ? null : sharedUint32(payload.positionValues),
    numeric: payload.numeric.map(entry => ({
      fieldPath: entry.fieldPath,
      docIds: sharedUint32(entry.docIds),
      values: sharedFloat64(entry.values),
    })),
    sizes: payload.sizes.map(entry => ({
      fieldPath: entry.fieldPath,
      docIds: sharedUint32(entry.docIds),
      values: sharedFloat64(entry.values),
    })),
    boolean: payload.boolean.map(entry => ({
      fieldPath: entry.fieldPath,
      trueDocs: sharedUint32(entry.trueDocs),
      falseDocs: sharedUint32(entry.falseDocs),
    })),
    enums: payload.enums.map(entry => ({
      fieldPath: entry.fieldPath,
      values: [...entry.values],
      offsets: sharedUint32(entry.offsets),
      docIds: sharedUint32(entry.docIds),
    })),
    geo: payload.geo.map(entry => ({
      fieldPath: entry.fieldPath,
      docIds: sharedUint32(entry.docIds),
      latitudes: sharedFloat64(entry.latitudes),
      longitudes: sharedFloat64(entry.longitudes),
    })),
    pattern: payload.pattern.map(entry => ({
      fieldPath: entry.fieldPath,
      docIds: sharedUint32(entry.docIds),
      runs: sharedUint32(entry.runs),
      offsets: sharedUint32(entry.offsets),
      postings: sharedUint32(entry.postings),
    })),
    surfaceTable: sharedSurfaceTable(payload),
    partialWords:
      reusedPartialWords === null
        ? sharedPartialWordsOf(tokenData, payload.partialSpellings, documentData, analysis)
        : sharePartialWordTable(reusedPartialWords),
  }
}
