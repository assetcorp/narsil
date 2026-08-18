import type { SerializedSurfaceForms } from '../../../types/internal'
import type { AnyDocument } from '../../../types/schema'
import { generateId } from '../../id-generator'
import type { SegmentPayload } from '../segment-payload'
import { type EncodedDocumentTableData, encodeDocumentTableData } from './document-source'
import { type ExternalIdTableData, encodeExternalIdTableData } from './external-ids'
import { encodeFrozenTokenTableData, type FrozenTokenTableData } from './token-table'

/**
 * One keyword segment frozen into shared memory. Every typed array is a view
 * over a SharedArrayBuffer, so posting this to a worker attaches the same
 * bytes instead of copying them, and nothing writes to it after the freeze.
 * Token and document id strings live as UTF-8 blobs and decode lazily on
 * whichever thread touches them. The small plain fields, field names, enum
 * values, and surface forms, still clone per worker.
 *
 * @internal
 */
export interface SharedSegmentSnapshot {
  segmentId: string
  documentCount: number
  fieldNames: string[]
  fieldLengthNames: string[]
  fieldLengthColumns: Uint32Array[]
  totalFieldLengths: Record<string, number>
  tokenTable: FrozenTokenTableData
  idTable: ExternalIdTableData
  documentTable: EncodedDocumentTableData
  postingOffsets: Uint32Array
  postingDocIds: Uint32Array
  postingFrequencies: Uint16Array
  postingFieldIndices: Uint8Array
  positionOffsets: Uint32Array | null
  positionValues: Uint32Array | null
  numeric: SegmentPayload['numeric']
  boolean: SegmentPayload['boolean']
  enums: SegmentPayload['enums']
  geo: SegmentPayload['geo']
  surfaceForms: SerializedSurfaceForms | null
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

export function freezeSegmentShared(
  payload: SegmentPayload,
  documents: ReadonlyArray<AnyDocument>,
  segmentId?: string,
): SharedSegmentSnapshot | null {
  if (typeof SharedArrayBuffer !== 'function') return null

  const tokenData = encodeFrozenTokenTableData(payload.tokens, payload.docFrequencies)
  const idData = encodeExternalIdTableData(payload.docIds)
  const documentData = encodeDocumentTableData(documents)

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
    },
    postingOffsets: sharedUint32(payload.postingOffsets),
    postingDocIds: sharedUint32(payload.postingDocIds),
    postingFrequencies: sharedUint16(payload.postingFrequencies),
    postingFieldIndices: sharedUint8(payload.postingFieldIndices),
    positionOffsets: payload.positionOffsets === null ? null : sharedUint32(payload.positionOffsets),
    positionValues: payload.positionValues === null ? null : sharedUint32(payload.positionValues),
    numeric: payload.numeric.map(entry => ({
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
    surfaceForms: payload.surfaceForms,
  }
}
