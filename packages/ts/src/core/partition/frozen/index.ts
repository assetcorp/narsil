import { prepareFrozenStrings } from '#platform/frozen-writes'
import { createLoadedGeoIndex } from '../../../geo/geo-code'
import type { GeoIndexReader } from '../../../geo/geo-index'
import type { FieldNameTable, SerializedSurfaceForms } from '../../../types/internal'
import type { AnyDocument } from '../../../types/schema'
import { registerExpansionSource } from '../../expansion/sources'
import type { BooleanFieldIndexReader, EnumFieldIndexReader, NumericFieldIndexReader } from '../../field-index'
import type { FrozenRemovalAnalysis } from '../../frozen-writes/removal-strings'
import { generateId } from '../../id-generator'
import { requirePatternSearch } from '../../pattern-index/registry'
import type { PatternIndexReader } from '../../pattern-index/types'
import { registerFrozenMergeSource } from '../../segment-merges/frozen-source'
import type { PartitionStatsView } from '../../statistics'
import { installStoredFields } from '../../stored-values/columns'
import { buildPartialWordTableFrom, createFrozenPartialWords } from '../partial-words/registry'
import type { FrozenPartialWordSlot, PartialWordTableData } from '../partial-words/types'
import type { PartitionReadState } from '../read-state'
import type { SegmentPayload } from '../segment-payload'
import type { SegmentColumns } from './columns'
import { createFrozenDocTable } from './doc-table'
import { wrapDocumentArray } from './document-array'
import type { EncodedDocumentTableData, FrozenDocumentSource } from './document-source'
import { buildExternalIdTable, type ExternalIdTable } from './external-ids'
import { createFrozenBooleanReader, createFrozenEnumReader, createFrozenNumericReader } from './field-indexes'
import { createFrozenInvertedReader } from './inverted-reader'
import { createFrozenLiveCounts, type FrozenLiveCounts } from './live-counts'
import type { PagedSegmentSnapshot } from './paged-snapshot'
import { createFrozenPostingViews, type FrozenPostingViews } from './posting-views'
import { createFrozenRemovalPass, type FrozenRemovalPass } from './removal-pass'
import type { SharedSegmentSnapshot } from './shared-snapshot'
import {
  createFrozenSurfaceSlot,
  type FrozenSurfaceSlot,
  type RemovedSpellings,
  type SurfaceTableReader,
} from './surface-slot'
import { buildFrozenTokenTable, type FrozenTokenTable } from './token-table'
import { createFrozenTombstones, type FrozenTombstones } from './tombstones'

export type { FrozenRemovalAnalysis } from '../../frozen-writes/removal-strings'
export type { PagedSegmentSnapshot } from './paged-snapshot'
export type { SharedSegmentSnapshot } from './shared-snapshot'
export type { FrozenTokenTable } from './token-table'
export { buildFrozenTokenTable } from './token-table'

export interface FrozenTombstone {
  readonly spellings: RemovedSpellings | undefined
  publish(): boolean
}

export interface FrozenSegment extends PartitionReadState {
  readonly segmentId: string
  readonly documentSource: FrozenDocumentSource
  readonly sharedSnapshot: SharedSegmentSnapshot | null
  readonly paged: PagedSegmentAccess | null
  readonly partialWords: FrozenPartialWordSlot
  readonly surfaces: FrozenSurfaceSlot
  readonly removals: FrozenRemovalPass
  /** The segment serves from these flat arrays, which a merge reads as they stand, decoding no document. */
  readonly arrays: FrozenSegmentArrays
  readonly tombstones: Pick<FrozenTombstones, 'size' | 'at'>
  liveDocumentCount(): number
  hasDocument(docId: string): boolean
  isTombstoned(ordinal: number): boolean
  removedSpellingsOf(docId: string): RemovedSpellings | undefined
  prepareTombstone(
    docId: string,
    removedSpellings?: RemovedSpellings,
    analysis?: FrozenRemovalAnalysis,
  ): FrozenTombstone | undefined
  tombstoneDocument(docId: string, removedSpellings?: RemovedSpellings): boolean
  tombstonedDocIds(): string[]
  removalBytes(): number
  pendingRemovals(): boolean
  settleRemovals(): void
}

export interface FrozenSegmentArrays extends Omit<SegmentColumns, 'surfaceForms'> {
  tokenTable: FrozenTokenTable
  idTable: ExternalIdTable
  /** This holds the documents as encoded bytes, and it reads null where the segment holds them as objects. */
  documentTable: EncodedDocumentTableData | null
  /** Reads the segment's surface forms, which it decodes from the shared table on the first call, and returns null where the segment holds none. */
  readSurfaceForms(): SerializedSurfaceForms | null
}

export interface FrozenSegmentSource extends FrozenSegmentArrays {
  docFrequencies: () => Readonly<Record<string, number>>
  surfaceTableOnDisk?: SurfaceTableReader
}

export interface PagedSegmentParts {
  access: PagedSegmentAccess
  createCounts(tombstones: FrozenTombstones): FrozenLiveCounts
  createViews(tombstones: FrozenTombstones, counts: FrozenLiveCounts): FrozenPostingViews
}

export interface PagedPostingList {
  docIds: Uint32Array
  termFrequencies: Uint16Array
  fieldNameIndices: Uint16Array
}

export interface PagedPositions {
  offsets: Uint32Array
  values: Uint32Array
}

export interface PagedSegmentAccess {
  readonly key: string
  readonly snapshot: PagedSegmentSnapshot
  readonly writeRecordsHeld: boolean
  payloadChecked: boolean
  listAt(sortedIndex: number): PagedPostingList
  positionsAt(sortedIndex: number): PagedPositions | null
  encodedDocumentAt(ordinal: number): Uint8Array
  writeRecordAt(ordinal: number): { seqNo: number; primaryTerm: number }
  heldBytes(segment: FrozenSegment): number
  termFrequenciesAcross(states: () => readonly PartitionReadState[]): Readonly<Record<string, number>>
  close(): void
  suspend(): void
  resume(rewrite: (path: string) => string): void
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
    addDocumentFrequencies(into: Record<string, number>): number {
      const frequencies = counts.docFrequencies()
      let added = 0
      for (const term in frequencies) {
        const held = into[term]
        if (held === undefined) {
          into[term] = frequencies[term]
          added++
        } else into[term] = held + frequencies[term]
      }
      return added
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
    const index = createLoadedGeoIndex()
    for (let i = 0; i < entry.docIds.length; i++) {
      index.insert(entry.docIds[i], entry.latitudes[i], entry.longitudes[i])
    }
    readers.set(entry.fieldPath, index)
  }
  return readers
}

export function assembleFrozenSegment(
  segmentId: string,
  source: FrozenSegmentSource,
  documentSource: FrozenDocumentSource,
  sharedSnapshot: SharedSegmentSnapshot | null,
  partialWordTable: PartialWordTableData | null,
  survivingSurfaceForms?: SerializedSurfaceForms,
  pagedParts?: PagedSegmentParts,
): FrozenSegment {
  const tombstones = createFrozenTombstones(source.documentCount)
  const counts =
    pagedParts?.createCounts(tombstones) ??
    createFrozenLiveCounts(source, source.tokenTable, tombstones, storedFrequenciesOf(source))
  const postingViews =
    pagedParts?.createViews(tombstones, counts) ?? createFrozenPostingViews(source, tombstones, counts)
  const lengthColumns = new Map<string, Uint32Array>()
  for (let i = 0; i < source.fieldLengthNames.length; i++) {
    lengthColumns.set(source.fieldLengthNames[i], source.fieldLengthColumns[i])
  }
  const docStore = createFrozenDocTable(source.idTable, lengthColumns, documentSource, tombstones)
  installStoredFields(docStore, source.storedFields ?? [])
  const partialWords = createFrozenPartialWords(partialWordTable, source.tokenTable, {
    count: documentSource.count,
    documentAt: ordinal => documentSource.readAt(ordinal),
    isTombstoned: ordinal => tombstones.has(ordinal),
    settleRemovals: counts.settleRemovals,
  })
  const textDocuments = {
    count: documentSource.count,
    textFields: source.fieldLengthNames,
    documentAt: (ordinal: number) => documentSource.readAt(ordinal),
  }
  const loadSurfaceForms = survivingSurfaceForms === undefined ? source.readSurfaceForms : () => survivingSurfaceForms
  const surfaces = createFrozenSurfaceSlot(
    loadSurfaceForms,
    textDocuments,
    survivingSurfaceForms === undefined ? source.surfaceTableOnDisk : undefined,
  )
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
    paged: pagedParts?.access ?? null,
    arrays: source,
    tombstones,
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
    trackPositions: pagedParts?.access.snapshot.tracksPositions ?? source.positionOffsets !== null,
    flatSchemaCache: null,
    lastSchemaRef: null,
    sortColumns: null,
    scoreBuffer: null,
    vectorOrdinalMaps: null,

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

    prepareTombstone(
      docId: string,
      removedSpellings?: RemovedSpellings,
      analysis?: FrozenRemovalAnalysis,
    ): FrozenTombstone | undefined {
      const ordinal = docStore.getInternalId(docId)
      if (ordinal === undefined || tombstones.has(ordinal)) return undefined
      const publishTombstone = tombstones.prepare(ordinal)
      const strings =
        analysis === undefined
          ? null
          : prepareFrozenStrings(
              source.fieldNames,
              source.fieldLengthNames,
              ordinal,
              documentSource.readAt(ordinal),
              analysis,
              surfaces,
              partialWords,
            )
      const subtractCounts = counts.prepareRemoval(ordinal, strings?.core)
      const subtractSpellings = strings?.publish ?? removals.prepareRemoval(ordinal, removedSpellings)
      const subtractPartial = strings === null ? partialWords.prepareRemoval(ordinal) : null
      return {
        spellings: strings?.spellings ?? removedSpellings,
        publish: () => {
          if (!publishTombstone()) return false
          subtractCounts()
          subtractPartial?.()
          subtractSpellings()
          docStore.releaseSortedDocIds()
          segment.sortColumns?.forget(ordinal)
          return true
        },
      }
    },

    tombstoneDocument(docId: string, removedSpellings?: RemovedSpellings): boolean {
      return segment.prepareTombstone(docId, removedSpellings)?.publish() ?? false
    },

    tombstonedDocIds(): string[] {
      const docIds: string[] = []
      for (const ordinal of tombstones.values()) docIds.push(source.idTable.idAt(ordinal))
      return docIds
    },

    removalBytes(): number {
      return counts.bytes() + tombstones.bytes()
    },

    pendingRemovals: counts.pendingRemovals,
    settleRemovals: counts.settleRemovals,
  }

  registerFrozenMergeSource(segment)
  const expansionSource = counts.expansionSource
  if (expansionSource !== undefined)
    registerExpansionSource(segment, () => {
      const source = expansionSource()
      const surface = surfaces.coreRegions()
      if (source.frozen === null || source.state === null) return source
      return {
        ...source,
        growing: null,
        frozen: { ...source.frozen, surfaces: surface.table },
        state: { ...source.state, removedSurfaces: surface.removed },
      }
    })
  return segment
}

export function assemblePagedFrozenSegment(
  segmentId: string,
  source: FrozenSegmentSource,
  documentSource: FrozenDocumentSource,
  partialWordTable: PartialWordTableData | null,
  parts: PagedSegmentParts,
): FrozenSegment {
  return assembleFrozenSegment(segmentId, source, documentSource, null, partialWordTable, undefined, parts)
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
