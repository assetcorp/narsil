import { ErrorCodes, NarsilError } from '../../../errors'
import { mergeFacets } from '../../../search/facets'
import type { FilterExpression } from '../../../types/filters'
import type { InternalSearchParams, InternalSearchResult } from '../../../types/internal'
import type { LanguageModule } from '../../../types/language'
import type { FacetResult } from '../../../types/results'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import type { FacetConfig } from '../../../types/search'
import type { ComparableSortValue } from '../../ordering'
import { compareCodePoints } from '../../ordering'
import { computeFacets } from '../facets'
import type { PartitionFilterMatches } from '../filters'
import { createFrozenSegment, type FrozenSegment } from '../frozen'
import { createPartitionIndex, type PartitionIndex, partitionStateOf } from '../index'
import type { PartitionSearchMatches } from '../matches'
import { estimatePartitionBytes } from '../memory'
import type { PartitionReadState } from '../read-state'
import type { SegmentPayload } from '../segment-payload'
import type { SortedPageEntry, SortPageRequest } from '../sorting'
import type { PartitionSuggestion } from '../suggestions'
import type { PartitionInsertOptions } from '../utils'
import {
  compositeFilterMatches,
  compositeFilters,
  compositeFiltersBitset,
  computeOrdinalLayout,
  type OrdinalLayout,
} from './filters'
import { compositeSearchFulltext, compositeSearchMatches } from './search'
import { compositeSortedPage, compositeSortValues } from './sorting'
import { buildAggregateStatsView } from './stats'
import { compositeExpandTermPrefix, compositeSuggestTerms } from './suggest'

/**
 * One partition served from a mutable live tail plus a list of immutable
 * frozen segments. Reads fan over every part and merge, writes land on the
 * live tail, and a remove or update of a frozen document tombstones it in its
 * segment. Frozen segments come first in the ordinal layout so their bases
 * never move as the live tail grows.
 *
 * @internal
 */
export interface CompositePartition extends PartitionIndex {
  readonly live: PartitionIndex
  frozenSegmentCount(): number
  appendFrozenSegment(payload: SegmentPayload, documents: ReadonlyArray<AnyDocument>): void
  attachFrozenSegment(segment: FrozenSegment): void
}

function frozenStateGuard(partitionId: number, operation: string, frozenCount: number): void {
  if (frozenCount === 0) return
  throw new NarsilError(
    ErrorCodes.PARTITION_CORRUPTED,
    `Partition ${partitionId} holds ${frozenCount} frozen segments, and ${operation} reads only the live tail, so it must run after compaction folds them in`,
    { partitionId, frozenCount, operation },
  )
}

export function createCompositePartition(
  partitionId: number,
  trackPositions = true,
  existingLive?: PartitionIndex,
): CompositePartition {
  const live = existingLive ?? createPartitionIndex(partitionId, trackPositions)
  const liveState = partitionStateOf(live)
  const frozen: FrozenSegment[] = []

  function subs(): PartitionReadState[] {
    return [...frozen, liveState]
  }

  function layout(): OrdinalLayout {
    return computeOrdinalLayout(subs())
  }

  function frozenOwner(docId: string): FrozenSegment | undefined {
    for (const segment of frozen) {
      if (segment.hasDocument(docId)) return segment
    }
    return undefined
  }

  return {
    get partitionId() {
      return partitionId
    },
    get live() {
      return live
    },

    get stats() {
      return buildAggregateStatsView([...frozen, liveState])
    },

    frozenSegmentCount(): number {
      return frozen.length
    },

    appendFrozenSegment(payload: SegmentPayload, documents: ReadonlyArray<AnyDocument>): void {
      for (const docId of payload.docIds) {
        if (live.has(docId) || frozenOwner(docId) !== undefined) {
          throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${docId}" already exists in this partition`, {
            docId,
            partitionId,
          })
        }
      }
      frozen.push(createFrozenSegment(payload, documents))
    },

    attachFrozenSegment(segment: FrozenSegment): void {
      for (const [docId] of segment.docStore.all()) {
        if (live.has(docId) || frozenOwner(docId) !== undefined) {
          throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${docId}" already exists in this partition`, {
            docId,
            partitionId,
          })
        }
      }
      frozen.push(segment)
    },

    mergeSegment(segment: PartitionIndex): void {
      live.mergeSegment(segment)
    },

    mergeSegmentPayload(payload: SegmentPayload, documents: ReadonlyArray<AnyDocument>): void {
      live.mergeSegmentPayload(payload, documents)
    },

    encodeSegment(): SegmentPayload {
      frozenStateGuard(partitionId, 'encodeSegment', frozen.length)
      return live.encodeSegment()
    },

    rebuildTextIndex(schema: SchemaDefinition, language: LanguageModule, options?: PartitionInsertOptions): void {
      frozenStateGuard(partitionId, 'rebuildTextIndex', frozen.length)
      live.rebuildTextIndex(schema, language, options)
    },

    serialize(indexName: string, totalPartitions: number, language: string, schema: SchemaDefinition) {
      frozenStateGuard(partitionId, 'serialize', frozen.length)
      return live.serialize(indexName, totalPartitions, language, schema)
    },

    serializeToBytes(indexName: string, totalPartitions: number, language: string, schema: SchemaDefinition) {
      frozenStateGuard(partitionId, 'serializeToBytes', frozen.length)
      return live.serializeToBytes(indexName, totalPartitions, language, schema)
    },

    deserialize(data, schema): void {
      frozen.length = 0
      live.deserialize(data, schema)
    },

    clear(): void {
      frozen.length = 0
      live.clear()
    },

    insert(docId, document, schema, language, options): void {
      if (frozenOwner(docId) !== undefined) {
        throw new NarsilError(
          ErrorCodes.DOC_ALREADY_EXISTS,
          `Document "${docId}" already exists in partition ${partitionId}`,
          { docId, partitionId },
        )
      }
      live.insert(docId, document, schema, language, options)
    },

    update(docId, document, schema, language, options): void {
      const owner = frozenOwner(docId)
      if (owner === undefined) {
        live.update(docId, document, schema, language, options)
        return
      }
      owner.tombstoneDocument(docId)
      live.insert(docId, document, schema, language, options)
    },

    remove(docId, schema, language, options): void {
      if (live.has(docId)) {
        live.remove(docId, schema, language, options)
        return
      }
      const owner = frozenOwner(docId)
      if (owner === undefined) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in partition ${partitionId}`, {
          docId,
          partitionId,
        })
      }
      owner.tombstoneDocument(docId)
    },

    beginBatch(): void {
      live.beginBatch()
    },

    endBatch(): void {
      live.endBatch()
    },

    searchFulltext(params: InternalSearchParams): InternalSearchResult {
      return compositeSearchFulltext(subs(), layout(), params)
    },

    searchFulltextMatches(params: InternalSearchParams): PartitionSearchMatches {
      return compositeSearchMatches(subs(), layout(), params)
    },

    applyFilters(filters: FilterExpression, schema: SchemaDefinition): Set<string> {
      return compositeFilters(subs(), filters, schema)
    },

    applyFiltersBitset(filters: FilterExpression, schema: SchemaDefinition): Uint32Array {
      return compositeFiltersBitset(subs(), layout(), filters, schema)
    },

    filterMatches(filters: FilterExpression, schema: SchemaDefinition): PartitionFilterMatches {
      return compositeFilterMatches(subs(), layout(), filters, schema)
    },

    computeFacets(docIds: Set<string>, config: FacetConfig, schema: SchemaDefinition): Record<string, FacetResult> {
      return mergeFacets(subs().map(sub => computeFacets(sub, docIds, config, schema)))
    },

    sortedPage(request: SortPageRequest): SortedPageEntry[] {
      return compositeSortedPage(subs(), layout(), request)
    },

    sortValues(docId, fields, fieldTypes): ComparableSortValue[] {
      return compositeSortValues(subs(), docId, fields, fieldTypes)
    },

    suggestTerms(surfacePrefix: string, stemmedPrefix: string, limit: number): PartitionSuggestion[] {
      return compositeSuggestTerms(subs(), surfacePrefix, stemmedPrefix, limit)
    },

    expandTermPrefix(surfacePrefix: string, stemmedToken: string, maxExpansions: number): string[] {
      return compositeExpandTermPrefix(subs(), surfacePrefix, stemmedToken, maxExpansions)
    },

    get(docId: string): AnyDocument | undefined {
      const owner = frozenOwner(docId)
      if (owner !== undefined) {
        const stored = owner.docStore.get(docId)
        return stored === undefined ? undefined : (structuredClone(stored.fields) as AnyDocument)
      }
      return live.get(docId)
    },

    getRef(docId: string): AnyDocument | undefined {
      const owner = frozenOwner(docId)
      if (owner !== undefined) {
        return owner.docStore.get(docId)?.fields as AnyDocument | undefined
      }
      return live.getRef(docId)
    },

    has(docId: string): boolean {
      return live.has(docId) || frozenOwner(docId) !== undefined
    },

    count(): number {
      let total = live.count()
      for (const segment of frozen) {
        total += segment.liveDocumentCount()
      }
      return total
    },

    *docIds(): IterableIterator<string> {
      for (const segment of frozen) {
        for (const [docId] of segment.docStore.all()) {
          yield docId
        }
      }
      yield* live.docIds()
    },

    sortedDocIds(): readonly string[] {
      const merged: string[] = []
      for (const segment of frozen) {
        merged.push(...segment.docStore.sortedDocIds())
      }
      merged.push(...live.sortedDocIds())
      merged.sort(compareCodePoints)
      return merged
    },

    releaseSortedDocIds(): void {
      for (const segment of frozen) {
        segment.docStore.releaseSortedDocIds()
      }
      live.releaseSortedDocIds()
    },

    estimateMemoryBytes(): number {
      let total = live.estimateMemoryBytes()
      for (const segment of frozen) {
        total += estimatePartitionBytes(segment)
      }
      return total
    },
  }
}
