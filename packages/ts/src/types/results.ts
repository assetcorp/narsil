import type { NarsilError } from '../errors'
import type { AnyDocument, SchemaDefinition } from './schema'

export interface QueryResult<T = AnyDocument> {
  hits: Array<Hit<T>>
  count: number
  elapsed: number
  cursor?: string
  facets?: Record<string, FacetResult>
  groups?: GroupResult[]
}

export interface Hit<T = AnyDocument> {
  id: string
  score: number
  document: T
  scoreComponents?: ScoreComponents
  highlights?: Record<string, HighlightMatch>
}

export interface ScoreComponents {
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
  idf: Record<string, number>
}

export interface HighlightMatch {
  snippet: string
  positions: Array<{ start: number; end: number }>
}

export interface FacetResult {
  values: Record<string, number>
  count: number
}

export interface GroupResult {
  values: Record<string, unknown>
  hits: Array<Hit>
}

export interface PreflightResult {
  count: number
  elapsed: number
}

export interface BatchResult {
  succeeded: string[]
  failed: Array<{ docId: string; error: NarsilError }>
}

export interface IndexStats {
  documentCount: number
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
  language: string
  schema: SchemaDefinition
}

export interface IndexInfo {
  name: string
  documentCount: number
  partitionCount: number
  language: string
}

export interface PartitionStatsResult {
  partitionId: number
  documentCount: number
  /**
   * Formula-based estimate of this partition's memory footprint. V8 has no
   * per-object heap accounting API, so this number is derived from structural
   * counters (document count, posting counts, field-index sizes) and does not
   * include per-object overhead. Treat as an estimate, not a measurement.
   */
  estimatedMemoryBytes: number
}

export interface SuggestResult {
  terms: Array<{
    term: string
    documentFrequency: number
  }>
  elapsed: number
}

/**
 * Snapshot of V8 heap usage as reported by `process.memoryUsage()`. All values
 * are bytes. `null` in environments that do not expose `process.memoryUsage`,
 * such as browsers.
 */
export interface ProcessMemoryReport {
  heapUsed: number
  heapTotal: number
  external: number
  rss: number
}

export interface MemoryStats {
  /**
   * V8 heap usage for the host process at the moment the call was made. This
   * is process-wide, not engine-wide; if multiple Narsil engines are running
   * in the same process every engine's `getMemoryStats` returns the same
   * `process` figures. `null` in browsers and any runtime where
   * `process.memoryUsage` is unavailable.
   */
  process: ProcessMemoryReport | null
  /**
   * Sum of every index's {@link IndexStats.estimatedMemoryBytes} held by this
   * engine. Formula-based; treat as an estimate, not a measurement. Useful
   * for cross-engine relative comparisons inside a single process where
   * `process.heapUsed` cannot tell engines apart.
   */
  estimatedIndexBytes: number
  /**
   * Per-worker V8 heap usage when the engine has been promoted to a worker
   * pool. Empty when no workers are active.
   */
  workers: Array<{
    workerId: number
    heapUsed: number
    heapTotal: number
    external: number
  }>
}

export interface VectorMaintenanceResult {
  fieldName: string
  tombstoneRatio: number
  graphCount: number
  bufferSize: number
  building: boolean
  estimatedCompactMs: number
  estimatedOptimizeMs: number
}
