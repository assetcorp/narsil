import { createGeoIndex, type GeoIndexReader } from '../../../geo/geo-index'
import type { FieldNameTable, SerializedSurfaceForms } from '../../../types/internal'
import type { AnyDocument } from '../../../types/schema'
import type { BooleanFieldIndexReader, EnumFieldIndexReader, NumericFieldIndexReader } from '../../field-index'
import { generateId } from '../../id-generator'
import type { PartitionStatsView } from '../../statistics'
import { createSurfaceRegistry, type SurfaceRegistryReader } from '../../surface-registry'
import type { PartitionReadState } from '../read-state'
import type { SegmentPayload } from '../segment-payload'
import { createFrozenDocTable } from './doc-table'
import { type FrozenDocumentSource, wrapDocumentArray, wrapEncodedDocumentTable } from './document-source'
import { buildExternalIdTable, type ExternalIdTable, wrapExternalIdTable } from './external-ids'
import { createFrozenBooleanReader, createFrozenEnumReader, createFrozenNumericReader } from './field-indexes'
import { createFrozenInvertedReader } from './inverted-reader'
import { createFrozenPostingViews } from './posting-views'
import type { SharedSegmentSnapshot } from './shared-snapshot'
import { buildFrozenTokenTable, type FrozenTokenTable, wrapFrozenTokenTable } from './token-table'
import { createFrozenTombstones } from './tombstones'

export type { SharedSegmentSnapshot } from './shared-snapshot'
export { freezeSegmentShared } from './shared-snapshot'
export type { FrozenTokenTable } from './token-table'
export { buildFrozenTokenTable } from './token-table'

/**
 * One immutable body of indexed documents served read-only from its flat
 * segment arrays. Removes tombstone an ordinal instead of rewriting the
 * arrays, and an update tombstones here and reinserts into the live tail.
 *
 * @internal
 */
export interface FrozenSegment extends PartitionReadState {
  readonly segmentId: string
  readonly documentSource: FrozenDocumentSource
  liveDocumentCount(): number
  hasDocument(docId: string): boolean
  tombstoneDocument(docId: string): boolean
}

interface FrozenSegmentSource {
  documentCount: number
  fieldNames: readonly string[]
  fieldLengthNames: readonly string[]
  fieldLengthColumns: readonly Uint32Array[]
  totalFieldLengths: Readonly<Record<string, number>>
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
  tokenTable: FrozenTokenTable
  idTable: ExternalIdTable
  docFrequencies: () => Readonly<Record<string, number>>
}

function buildStatsView(source: FrozenSegmentSource): PartitionStatsView {
  const averageFieldLengths: Record<string, number> = {}
  if (source.documentCount > 0) {
    for (const [fieldName, total] of Object.entries(source.totalFieldLengths)) {
      averageFieldLengths[fieldName] = total / source.documentCount
    }
  }
  let materializedFrequencies: Readonly<Record<string, number>> | null = null
  return {
    totalDocuments: source.documentCount,
    totalFieldLengths: source.totalFieldLengths,
    averageFieldLengths,
    get docFrequencies(): Readonly<Record<string, number>> {
      if (materializedFrequencies === null) {
        materializedFrequencies = source.docFrequencies()
      }
      return materializedFrequencies
    },
  }
}

function buildSurfaceReader(surfaceForms: SerializedSurfaceForms | null): SurfaceRegistryReader {
  const registry = createSurfaceRegistry()
  if (surfaceForms !== null) {
    registry.deserialize(surfaceForms)
  }
  return registry
}

function buildGeoReaders(entries: SegmentPayload['geo']): Map<string, GeoIndexReader> {
  const readers = new Map<string, GeoIndexReader>()
  for (const entry of entries) {
    const index = createGeoIndex()
    for (let i = 0; i < entry.docIds.length; i++) {
      index.insert(entry.docIds[i], entry.latitudes[i], entry.longitudes[i])
    }
    readers.set(entry.fieldPath, index)
  }
  return readers
}

function assembleFrozenSegment(
  segmentId: string,
  source: FrozenSegmentSource,
  documentSource: FrozenDocumentSource,
): FrozenSegment {
  const tombstones = createFrozenTombstones()
  const postingViews = createFrozenPostingViews(source, tombstones)
  const lengthColumns = new Map<string, Uint32Array>()
  for (let i = 0; i < source.fieldLengthNames.length; i++) {
    lengthColumns.set(source.fieldLengthNames[i], source.fieldLengthColumns[i])
  }
  const docStore = createFrozenDocTable(source.idTable, lengthColumns, documentSource, tombstones)

  const numericIndexes = new Map<string, NumericFieldIndexReader>()
  for (const entry of source.numeric) numericIndexes.set(entry.fieldPath, createFrozenNumericReader(entry))
  const booleanIndexes = new Map<string, BooleanFieldIndexReader>()
  for (const entry of source.boolean) booleanIndexes.set(entry.fieldPath, createFrozenBooleanReader(entry))
  const enumIndexes = new Map<string, EnumFieldIndexReader>()
  for (const entry of source.enums) enumIndexes.set(entry.fieldPath, createFrozenEnumReader(entry))

  const fieldNameTable: FieldNameTable = {
    names: [...source.fieldNames],
    indexMap: new Map(source.fieldNames.map((name, index) => [name, index])),
  }

  const segment: FrozenSegment = {
    segmentId,
    documentSource,
    invertedIdx: createFrozenInvertedReader(source.tokenTable, postingViews),
    docStore,
    stats: buildStatsView(source),
    surfaceRegistry: buildSurfaceReader(source.surfaceForms),
    numericIndexes,
    booleanIndexes,
    enumIndexes,
    geoIndexes: buildGeoReaders(source.geo),
    fieldNameTable,
    trackPositions: source.positionOffsets !== null,
    flatSchemaCache: null,
    lastSchemaRef: null,
    sortColumns: null,
    scoreBuffer: null,

    liveDocumentCount(): number {
      return source.documentCount - tombstones.size
    },

    hasDocument(docId: string): boolean {
      return docStore.has(docId)
    },

    tombstoneDocument(docId: string): boolean {
      const ordinal = docStore.getInternalId(docId)
      if (ordinal === undefined) return false
      const added = tombstones.add(ordinal)
      if (added) {
        docStore.releaseSortedDocIds()
        segment.sortColumns = null
        segment.scoreBuffer = null
      }
      return added
    },
  }

  return segment
}

export function createFrozenSegment(
  payload: SegmentPayload,
  documents: ReadonlyArray<AnyDocument>,
  segmentId?: string,
): FrozenSegment {
  return assembleFrozenSegment(
    segmentId ?? generateId(),
    {
      ...payload,
      tokenTable: buildFrozenTokenTable(payload.tokens, payload.docFrequencies),
      idTable: buildExternalIdTable(payload.docIds),
      docFrequencies: () => payload.docFrequencies,
    },
    wrapDocumentArray(documents),
  )
}

export function createSharedFrozenSegment(snapshot: SharedSegmentSnapshot): FrozenSegment {
  const tokenTable = wrapFrozenTokenTable(snapshot.tokenTable)
  return assembleFrozenSegment(
    snapshot.segmentId,
    {
      ...snapshot,
      tokenTable,
      idTable: wrapExternalIdTable(snapshot.idTable),
      docFrequencies: () => {
        const frequencies: Record<string, number> = Object.create(null)
        for (let at = 0; at < tokenTable.size; at++) {
          frequencies[tokenTable.tokenAt(at)] = tokenTable.documentFrequencyAt(at)
        }
        return frequencies
      },
    },
    wrapEncodedDocumentTable(snapshot.documentTable),
  )
}
