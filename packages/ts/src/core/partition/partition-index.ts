import type { FilterExpression } from '../../types/filters'
import type { InternalSearchParams, InternalSearchResult, SerializablePartition } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { FacetResult } from '../../types/results'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import type { ComparableSortValue } from '../ordering'
import type { ResolvedProjection } from '../projection'
import type { PartitionStatsView } from '../statistics'
import type { FacetMatchSet } from './facets'
import type { PartitionFilterMatches } from './filters'
import type { PartitionSearchMatches } from './matches'
import type { SegmentPayload } from './segment-payload'
import type { SortedPageEntry, SortPageRequest } from './sorting'
import type { PartitionSuggestion } from './suggestions'
import type { PartitionInsertOptions } from './utils'

export interface PartitionIndex {
  readonly partitionId: number
  readonly stats: PartitionStatsView

  insert(
    docId: string,
    document: AnyDocument,
    schema: SchemaDefinition,
    language: LanguageModule,
    options?: PartitionInsertOptions,
  ): void
  remove(docId: string, schema: SchemaDefinition, language: LanguageModule, options?: PartitionInsertOptions): void
  beginBatch(): void
  endBatch(): void
  mergeSegment(segment: PartitionIndex): void
  encodeSegment(): SegmentPayload
  mergeSegmentPayload(payload: SegmentPayload, documents: ReadonlyArray<AnyDocument>): void
  update(
    docId: string,
    document: AnyDocument,
    schema: SchemaDefinition,
    language: LanguageModule,
    options?: PartitionInsertOptions,
  ): void
  rebuildTextIndex(schema: SchemaDefinition, language: LanguageModule, options?: PartitionInsertOptions): void
  get(docId: string, projection?: ResolvedProjection): AnyDocument | undefined
  getRef(docId: string): AnyDocument | undefined
  has(docId: string): boolean
  count(): number
  docIds(): IterableIterator<string>
  sortedDocIds(): readonly string[]
  releaseSortedDocIds(): void
  clear(): void

  searchFulltext(params: InternalSearchParams): InternalSearchResult
  searchFulltextMatches(params: InternalSearchParams): PartitionSearchMatches
  sortedPage(request: SortPageRequest): SortedPageEntry[]
  sortValues(
    docId: string,
    fields: readonly string[],
    fieldTypes: readonly (string | undefined)[],
  ): ComparableSortValue[]
  applyFilters(filters: FilterExpression, schema: SchemaDefinition): Set<string>
  applyFiltersBitset(filters: FilterExpression, schema: SchemaDefinition): Uint32Array
  filterMatches(filters: FilterExpression, schema: SchemaDefinition): PartitionFilterMatches
  computeFacets(matched: FacetMatchSet, config: FacetConfig, schema: SchemaDefinition): Record<string, FacetResult>
  suggestTerms(surfacePrefix: string, stemmedPrefix: string, limit: number): PartitionSuggestion[]
  expandTermPrefix(surfacePrefix: string, stemmedToken: string, maxExpansions: number): string[]

  estimateMemoryBytes(): number

  serialize(
    indexName: string,
    totalPartitions: number,
    language: string,
    schema: SchemaDefinition,
  ): SerializablePartition
  serializeToBytes(indexName: string, totalPartitions: number, language: string, schema: SchemaDefinition): Uint8Array
  deserialize(data: SerializablePartition, schema: SchemaDefinition): void
}
