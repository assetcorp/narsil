import type { NarsilError } from '../errors'
import type { AnyDocument, SchemaDefinition } from './schema'

/**
 * What {@link Narsil.query} returns: the ranked hits and everything the query
 * asked for alongside them.
 *
 * @typeParam T - Shape of the stored documents, which flows through to each
 * hit's `document`.
 *
 * @public
 */
export interface QueryResult<T = AnyDocument> {
  /** These documents matched, cut to the query's `limit`, best score first or in the query's sort order. */
  hits: Array<Hit<T>>
  /** This many documents matched in total, before `limit` and `offset` applied. */
  count: number
  /** The engine spent this many milliseconds on the search. */
  elapsed: number
  /** This opaque cursor reaches the next page. Pass it back as `searchAfter`. */
  cursor?: string
  /** These facet counts are keyed by the field each facet was asked for. */
  facets?: Record<string, FacetResult>
  /** These groups arrive when the query asked for grouping. */
  groups?: GroupResult[]
  /** This turns true when the index's terms came from an older analysis than its language module produces now. */
  analysisStale?: boolean
  /** The search read this much of the index, which is how you spot a degraded answer. */
  coverage: QueryCoverage
}

/**
 * How much of an index one search read, which is what you check before you
 * trust a count or a ranking.
 *
 * An embedded engine reads every partition it holds, so `queriedPartitions`
 * matches `totalPartitions` there and the other two stay zero. A search across
 * a cluster may find a node slow or unreachable, which it counts here while
 * still returning the hits the other nodes gave it.
 *
 * @public
 */
export interface QueryCoverage {
  /** The search should have read this many partitions. */
  totalPartitions: number
  /** The search read this many of them. */
  queriedPartitions: number
  /** The search counts a partition here when the node holding it took longer than the query allowed. */
  timedOutPartitions: number
  /** The search counts a partition here when the node holding it returned an error, and when no active replica served it. */
  failedPartitions: number
}

/**
 * One matching document, with the score that ranked it.
 *
 * @typeParam T - Shape of the stored document.
 *
 * @public
 */
export interface Hit<T = AnyDocument> {
  /** The document is stored under this id. */
  id: string
  /**
   * This score ranked the hit. Scores compare within one result set, never
   * across searches. A sorted query ranks by sort values instead and carries
   * no score unless it sets `includeScores`.
   */
  score?: number
  /** This is the stored document. */
  document: T
  /** These are the parts the score was built from, which arrive when the query asked for them. */
  scoreComponents?: ScoreComponents
  /** These highlighted snippets are keyed by field, and arrive when the query asked for highlighting. */
  highlights?: Record<string, HighlightMatch>
}

/**
 * The numbers BM25 combined into one hit's score, which is what you read when
 * a ranking surprises you.
 *
 * @public
 */
export interface ScoreComponents {
  /** Each query term appears in this document this often, keyed by term. */
  termFrequencies: Record<string, number>
  /** Each field the query searched holds this many tokens, keyed by field. */
  fieldLengths: Record<string, number>
  /** Each query term carries this inverse document frequency, which is what makes a rare term count for more. */
  idf: Record<string, number>
}

/**
 * A highlighted field, ready to render.
 *
 * @public
 */
export interface HighlightMatch {
  /** This is the field's text around the match, wrapped in the query's tags. */
  snippet: string
  /** The match covers these character ranges in the original field, for rendering the highlight yourself. */
  positions: Array<{ start: number; end: number }>
}

/**
 * Counts for one faceted field.
 *
 * @public
 */
export interface FacetResult {
  /** This many documents matched per value, keyed by value. */
  values: Record<string, number>
  /** The field held this many distinct values across the matching documents. */
  count: number
  /**
   * No value's count is short by more than this. Counting runs per partition
   * and each one reports only its own top values, so a value that is common
   * overall but ranks low on a partition loses that partition's share. A bound
   * of 0 means every count here is exact.
   */
  errorBound: number
}

/**
 * One group of hits, produced by a query that grouped its results.
 *
 * @public
 */
export interface GroupResult {
  /** Each grouping field holds this value for the group, keyed by field. */
  values: Record<string, unknown>
  /** These hits fall in the group, cut to the query's `maxPerGroup`. */
  hits: Array<Hit>
  /** The query's reducer produced this value for the group, and only a query that set `group.reduce` carries it. */
  reduced?: unknown
  /** The reducer threw, and this holds its message, so the group carries its hits and no `reduced` value. */
  reducerError?: string
}

/**
 * What {@link Narsil.preflight} returns: how many documents a query matches,
 * without building or ranking a single hit.
 *
 * @public
 */
export interface PreflightResult {
  /** The query matches this many documents. */
  count: number
  /** The count took this many milliseconds. */
  elapsed: number
  /** This turns true when the index's terms came from an older analysis than its language module produces now. */
  analysisStale?: boolean
}

/**
 * What a batch write returns. One bad document never abandons the rest, so
 * read both lists.
 *
 * @public
 */
export interface BatchResult {
  /** The engine wrote the documents under these ids. */
  succeeded: string[]
  /** The engine rejected each of these documents, and each entry carries the error that rejected it. */
  failed: Array<{ docId: string; error: NarsilError }>
}

/**
 * What {@link Narsil.getStats} returns about one index.
 *
 * @public
 */
export interface IndexStats {
  /** The index holds this many documents. A closed index reports its count as of the last checkpoint. */
  documentCount: number
  /** The index is spread across this many partitions. */
  partitionCount: number
  /**
   * Formula-based estimate of the index's main-thread memory footprint, summed
   * across every partition and vector index for this index. Computed from
   * structural counters (document count, posting counts, field-index sizes),
   * not measured. Per-object V8 overhead (hidden classes, map transitions,
   * GC headers) is not captured here, so this number routinely undershoots
   * the real heap by a meaningful factor. Use {@link Narsil.getMemoryStats}
   * when sizing host memory.
   */
  estimatedMemoryBytes: number
  /** The index analyses text with this language module. */
  language: string
  /** The index was created with this field layout. */
  schema: SchemaDefinition
}

/**
 * A summary of one index, as {@link Narsil.listIndexes} reports it.
 *
 * @public
 */
export interface IndexInfo {
  /** The index was created under this name. */
  name: string
  /** The index holds this many documents. A closed index reports its count as of the last checkpoint. */
  documentCount: number
  /** The index is spread across this many partitions. */
  partitionCount: number
  /** The index analyses text with this language module. */
  language: string
  /** This turns true when the index's terms came from an older analysis than its language module produces now. */
  analysisStale?: boolean
  /** This is `open` in memory, `closed` after release, and `reopen-failed` after five recovery failures. */
  state: 'open' | 'closed' | 'reopen-failed'
  /** This counts successful loads since this engine started. */
  reopenCount: number
}

/**
 * What {@link Narsil.getPartitionStats} reports for one partition, which is
 * where you look when an index grows unevenly.
 *
 * @public
 */
export interface PartitionStatsResult {
  /** This identifies the partition within its index. */
  partitionId: number
  /** The partition holds this many documents. */
  documentCount: number
  /**
   * Formula-based estimate of this partition's memory footprint. V8 has no
   * per-object heap accounting API, so this number is derived from structural
   * counters (document count, posting counts, field-index sizes) and does not
   * include per-object overhead. Treat as an estimate, not a measurement.
   */
  estimatedMemoryBytes: number
}

/**
 * What {@link Narsil.suggest} returns: the indexed terms that complete a
 * prefix, ready to offer as you-type suggestions.
 *
 * @public
 */
export interface SuggestResult {
  /** These completions run most widely used first. */
  terms: Array<{
    /** This is the completed term, as the index holds it. */
    term: string
    /** The term appears in this many documents, which is what ordered the list. */
    documentFrequency: number
  }>
  /** The lookup took this many milliseconds. */
  elapsed: number
  /** This turns true when the index's terms came from an older analysis than its language module produces now. */
  analysisStale?: boolean
}

/**
 * The state of one vector field, and what maintenance would cost, as
 * {@link Narsil.vectorMaintenanceStatus} reports it.
 *
 * Removing a vector leaves a tombstone in the graph, and enough of them slow a
 * search down. Read this to decide when compaction earns its cost.
 *
 * @public
 */
export interface VectorMaintenanceResult {
  /** This describes the named vector field. */
  fieldName: string
  /** Tombstones make up this share of the graph's nodes, from 0 to 1. */
  tombstoneRatio: number
  /** The field's HNSW graph holds this many vectors. */
  graphCount: number
  /** This many vectors wait outside the graph, which a search scans one by one. */
  bufferSize: number
  /** This stays true while a graph build runs. */
  building: boolean
  /** {@link Narsil.compactVectors} would take about this many milliseconds. */
  estimatedCompactMs: number
  /** {@link Narsil.optimizeVectors} would take about this many milliseconds. */
  estimatedOptimizeMs: number
}

/**
 * One stored document, as {@link Narsil.listDocuments} returns it.
 *
 * @typeParam T - Shape of the stored document.
 *
 * @public
 */
export interface ListedDocument<T = AnyDocument> {
  /** The document is stored under this id. */
  id: string
  /** This holds the stored document, cut down to what the projection kept. */
  document: T
}

/**
 * What {@link Narsil.listDocuments} returns: one page of stored documents and
 * the cursor that reaches the next one.
 *
 * @typeParam T - Shape of the stored documents.
 *
 * @public
 */
export interface ListResult<T = AnyDocument> {
  /** These documents make up the page, in ascending document-id order. */
  documents: Array<ListedDocument<T>>
  /** This opaque cursor reaches the next page, and is null once the listing is finished. */
  cursor: string | null
  /** The listing covers this many documents in total, and any filter narrows that count. */
  total: number
  /** The engine spent this many milliseconds building the page. */
  elapsed: number
}
