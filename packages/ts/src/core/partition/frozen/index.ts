import { createGeoIndex, type GeoIndexReader } from '../../../geo/geo-index'
import type { FieldNameTable, SerializedSurfaceForms } from '../../../types/internal'
import type { AnyDocument } from '../../../types/schema'
import type { BooleanFieldIndexReader, EnumFieldIndexReader, NumericFieldIndexReader } from '../../field-index'
import { generateId } from '../../id-generator'
import { requirePatternSearch } from '../../pattern-index/registry'
import type { PatternIndexReader } from '../../pattern-index/types'
import type { PartitionStatsView } from '../../statistics'
import { buildPartialWordTableFrom, createFrozenPartialWords } from '../partial-words/registry'
import type { FrozenPartialWordSlot, PartialWordTableData } from '../partial-words/types'
import type { PartitionReadState } from '../read-state'
import type { SegmentPayload } from '../segment-payload'
import type { SegmentColumns } from './columns'
import { createFrozenDocTable } from './doc-table'
import {
  type EncodedDocumentTableData,
  type FrozenDocumentSource,
  wrapDocumentArray,
  wrapEncodedDocumentTable,
} from './document-source'
import { buildExternalIdTable, type ExternalIdTable, wrapExternalIdTable } from './external-ids'
import { createFrozenBooleanReader, createFrozenEnumReader, createFrozenNumericReader } from './field-indexes'
import { createFrozenInvertedReader } from './inverted-reader'
import { createFrozenLiveCounts, type FrozenLiveCounts } from './live-counts'
import { createFrozenPostingViews } from './posting-views'
import { createFrozenRemovalPass, type FrozenRemovalPass } from './removal-pass'
import type { SharedSegmentSnapshot } from './shared-snapshot'
import { createFrozenSurfaceSlot, type FrozenSurfaceSlot, type RemovedSpellings } from './surface-slot'
import { decodeSurfaceTable } from './surface-table'
import { buildFrozenTokenTable, type FrozenTokenTable, wrapFrozenTokenTable } from './token-table'
import { createFrozenTombstones } from './tombstones'

export type { SharedSegmentSnapshot } from './shared-snapshot'
export { freezeSegmentShared, shareSegmentArrays } from './shared-snapshot'
export type { FrozenTokenTable } from './token-table'
export { buildFrozenTokenTable } from './token-table'

export interface FrozenSegment extends PartitionReadState {
  readonly segmentId: string
  readonly documentSource: FrozenDocumentSource
  readonly sharedSnapshot: SharedSegmentSnapshot | null
  readonly partialWords: FrozenPartialWordSlot
  readonly surfaces: FrozenSurfaceSlot
  readonly removals: FrozenRemovalPass
  /** The segment serves from these flat arrays, which a merge reads as they stand, decoding no document. */
  readonly arrays: FrozenSegmentArrays
  liveDocumentCount(): number
  hasDocument(docId: string): boolean
  isTombstoned(ordinal: number): boolean
  removedSpellingsOf(docId: string): RemovedSpellings | undefined
  tombstoneDocument(docId: string, removedSpellings?: RemovedSpellings): boolean
  tombstonedDocIds(): string[]
  removalBytes(): number
}

export interface FrozenSegmentArrays extends Omit<SegmentColumns, 'surfaceForms'> {
  tokenTable: FrozenTokenTable
  idTable: ExternalIdTable
  /** This holds the documents as encoded bytes, and it reads null where the segment holds them as objects. */
  documentTable: EncodedDocumentTableData | null
  /** Reads the segment's surface forms, which it decodes from the shared table on the first call, and returns null where the segment holds none. */
  readSurfaceForms(): SerializedSurfaceForms | null
}

interface FrozenSegmentSource extends FrozenSegmentArrays {
  docFrequencies: () => Readonly<Record<string, number>>
}

function buildStatsView(counts: FrozenLiveCounts): PartitionStatsView {
  return {
    get totalDocuments(): number {
      return counts.totalDocuments()
    },
    get totalFieldLengths(): Readonly<Record<string, number>> {
      return counts.totalFieldLengths()
    },
    get averageFieldLengths(): Record<string, number> {
      const documents = counts.totalDocuments()
      const averages: Record<string, number> = {}
      if (documents > 0) {
        for (const [fieldName, total] of Object.entries(counts.totalFieldLengths())) {
          averages[fieldName] = total / documents
        }
      }
      return averages
    },
    get docFrequencies(): Readonly<Record<string, number>> {
      return counts.docFrequencies()
    },
  }
}

function storedFrequenciesOf(source: FrozenSegmentSource): () => Readonly<Record<string, number>> {
  let materialized: Readonly<Record<string, number>> | null = null
  return () => {
    if (materialized === null) materialized = source.docFrequencies()
    return materialized
  }
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
  sharedSnapshot: SharedSegmentSnapshot | null,
  partialWordTable: PartialWordTableData | null,
  survivingSurfaceForms?: SerializedSurfaceForms,
): FrozenSegment {
  const tombstones = createFrozenTombstones()
  const counts = createFrozenLiveCounts(source, source.tokenTable, tombstones, storedFrequenciesOf(source))
  const postingViews = createFrozenPostingViews(source, tombstones, counts)
  const lengthColumns = new Map<string, Uint32Array>()
  for (let i = 0; i < source.fieldLengthNames.length; i++) {
    lengthColumns.set(source.fieldLengthNames[i], source.fieldLengthColumns[i])
  }
  const docStore = createFrozenDocTable(source.idTable, lengthColumns, documentSource, tombstones)
  const partialWords = createFrozenPartialWords(partialWordTable, source.tokenTable, {
    count: documentSource.count,
    documentAt: ordinal => documentSource.readAt(ordinal),
    isTombstoned: ordinal => tombstones.has(ordinal),
  })
  const textDocuments = {
    count: documentSource.count,
    textFields: source.fieldLengthNames,
    documentAt: (ordinal: number) => documentSource.readAt(ordinal),
  }
  const loadSurfaceForms = survivingSurfaceForms === undefined ? source.readSurfaceForms : () => survivingSurfaceForms
  const surfaces = createFrozenSurfaceSlot(loadSurfaceForms, textDocuments)
  const removals = createFrozenRemovalPass(textDocuments, surfaces)

  const numericIndexes = new Map<string, NumericFieldIndexReader>()
  for (const entry of source.numeric) numericIndexes.set(entry.fieldPath, createFrozenNumericReader(entry))
  const sizeIndexes = new Map<string, NumericFieldIndexReader>()
  for (const entry of source.sizes) sizeIndexes.set(entry.fieldPath, createFrozenNumericReader(entry))
  const booleanIndexes = new Map<string, BooleanFieldIndexReader>()
  for (const entry of source.boolean) booleanIndexes.set(entry.fieldPath, createFrozenBooleanReader(entry))
  const enumIndexes = new Map<string, EnumFieldIndexReader>()
  for (const entry of source.enums) enumIndexes.set(entry.fieldPath, createFrozenEnumReader(entry))
  const patternIndexes = new Map<string, PatternIndexReader>()
  for (const entry of source.pattern) {
    patternIndexes.set(entry.fieldPath, requirePatternSearch(entry.fieldPath).readArrays(entry))
  }

  const fieldNameTable: FieldNameTable = {
    names: [...source.fieldNames],
    indexMap: new Map(source.fieldNames.map((name, index) => [name, index])),
  }

  const segment: FrozenSegment = {
    segmentId,
    documentSource,
    sharedSnapshot,
    arrays: source,
    invertedIdx: createFrozenInvertedReader(source.tokenTable, postingViews, counts),
    docStore,
    stats: buildStatsView(counts),
    surfaceRegistry: surfaces.reader,
    surfaces,
    removals,
    numericIndexes,
    booleanIndexes,
    enumIndexes,
    geoIndexes: buildGeoReaders(source.geo),
    patternIndexes,
    sizeIndexes,
    fieldNameTable,
    partialWords,
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

    isTombstoned(ordinal: number): boolean {
      return tombstones.has(ordinal)
    },

    removedSpellingsOf(docId: string): RemovedSpellings | undefined {
      const ordinal = docStore.getInternalId(docId)
      if (ordinal === undefined || tombstones.has(ordinal)) return undefined
      return removals.spellingsOf(ordinal)
    },

    tombstoneDocument(docId: string, removedSpellings?: RemovedSpellings): boolean {
      const ordinal = docStore.getInternalId(docId)
      if (ordinal === undefined) return false
      const added = tombstones.add(ordinal)
      if (added) {
        counts.subtractRemoved(ordinal)
        partialWords.afterRemoval(ordinal)
        removals.afterRemoval(ordinal, removedSpellings)
        docStore.releaseSortedDocIds()
        segment.sortColumns?.forget(ordinal)
      }
      return added
    },

    tombstonedDocIds(): string[] {
      const docIds: string[] = []
      for (const ordinal of tombstones.values()) docIds.push(source.idTable.idAt(ordinal))
      return docIds
    },

    removalBytes(): number {
      return counts.bytes()
    },
  }

  return segment
}

export function createFrozenSegment(
  payload: SegmentPayload,
  documents: ReadonlyArray<AnyDocument>,
  segmentId?: string,
): FrozenSegment {
  const tokenTable = buildFrozenTokenTable(payload.tokens, payload.docFrequencies)
  return assembleFrozenSegment(
    segmentId ?? generateId(),
    {
      ...payload,
      tokenTable,
      idTable: buildExternalIdTable(payload.docIds),
      documentTable: null,
      readSurfaceForms: () => payload.surfaceForms,
      docFrequencies: () => payload.docFrequencies,
    },
    wrapDocumentArray(documents),
    null,
    payload.partialSpellings === null ? null : buildPartialWordTableFrom(payload.partialSpellings, tokenTable),
  )
}

export function createSharedFrozenSegment(
  snapshot: SharedSegmentSnapshot,
  survivingSurfaceForms?: SerializedSurfaceForms,
): FrozenSegment {
  const tokenTable = wrapFrozenTokenTable(snapshot.tokenTable)
  return assembleFrozenSegment(
    snapshot.segmentId,
    {
      ...snapshot,
      tokenTable,
      idTable: wrapExternalIdTable(snapshot.idTable),
      documentTable: snapshot.documentTable,
      readSurfaceForms: () => (snapshot.surfaceTable === null ? null : decodeSurfaceTable(snapshot.surfaceTable)),
      docFrequencies: () => {
        const frequencies: Record<string, number> = Object.create(null)
        for (let at = 0; at < tokenTable.size; at++) {
          frequencies[tokenTable.tokenAt(at)] = tokenTable.documentFrequencyAt(at)
        }
        return frequencies
      },
    },
    wrapEncodedDocumentTable(snapshot.documentTable),
    snapshot,
    snapshot.partialWords,
    survivingSurfaceForms,
  )
}
