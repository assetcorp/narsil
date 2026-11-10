import type { NativeAnalysisCore } from '../analysis-types'
import type { NativeKeywordCore } from '../keyword-types'
import type { NativeExpansionCore } from './expansion'
import type { NativeFacetCore } from './facets'
import type { NativeFieldMergeCore } from './field-merge'
import type { NativeFilterCore } from './filters'
import type { NativeFrozenSegmentCore } from './frozen-segments'
import type { NativeGroupCore } from './groups'
import type { NativeHighlightCore } from './highlight'
import type {
  NativeConnectResult,
  NativeGraphHandle,
  NativeGraphMemory,
  NativeScoreResult,
  NativeSearchResult,
  NativeStoreHandle,
  NativeStoreMemory,
} from './memory'
import type { NativePagedCore } from './paged'
import type { NativePatternCore } from './pattern'
import type { NativePhraseCore } from './phrases'
import type { NativeResultCore } from './results'
import type { NativeSegmentMergeCore } from './segment-merge'
import type { NativeSegmentCore } from './segments'
import type { NativeSortCore } from './sort'
import type { NativeSynonymCore } from './synonyms'
import type { NativeTermCore } from './terms'

export type {
  NativeConnectResult,
  NativeGraphHandle,
  NativeGraphMemory,
  NativeScoreResult,
  NativeSearchResult,
  NativeStoreHandle,
  NativeStoreMemory,
} from './memory'

export const NATIVE_CORE_ABI_VERSION = 50
export const NATIVE_OK = 0
export const NATIVE_NEEDS_ROOM = 3
export const NATIVE_GRAPH_NOT_HELD_ALONE = 4
export const NATIVE_SEGMENT_FULL = 8

/**
 * The operations of the native search core, which each return a status code from the core's header, or, for a
 * search, the number of candidates found.
 *
 * @internal
 */
export interface NativeCore
  extends NativeAnalysisCore,
    NativeExpansionCore,
    NativeKeywordCore,
    NativeFacetCore,
    NativeFieldMergeCore,
    NativeFilterCore,
    NativeFrozenSegmentCore,
    NativeGroupCore,
    NativeHighlightCore,
    NativePagedCore,
    NativePatternCore,
    NativePhraseCore,
    NativeResultCore,
    NativeSegmentCore,
    NativeSegmentMergeCore,
    NativeSortCore,
    NativeSynonymCore,
    NativeTermCore {
  /** Returns the version of the core's binary interface, which the engine compares with the version that it was built for. */
  abiVersion(): number
  /** Returns the number of bytes that the core's working memory holds. */
  workspaceBytes(): number
  /**
   * Writes into each place of `results` the value of one deterministic maths function at the same place of
   * `first`, computed with the fdlibm algorithms that the specification fixes, so that a port of these functions
   * in another language can compare its results with the core's beyond the published test vectors. The call
   * counts no work.
   *
   * @param operation - The function's index from the core's header: ln, sin, cos, tan, asin, atan, or atan2.
   * @param first - The argument at each place, or `y` at each place for atan2. It must hold as many values as
   * `results`, or the core refuses the call.
   * @param second - `x` at each place for atan2, which must then hold as many values as `results`. Every other
   * function ignores it.
   * @param results - The array that receives one result for each place of `first`.
   * @returns A status code from the core's header.
   */
  applyMath(operation: number, first: Float64Array, second: Float64Array, results: Float64Array): number
  /**
   * Attaches the memory of one graph to the core.
   *
   * @param memory - The graph's regions.
   * @returns The handle that every later call on this graph takes.
   */
  attachGraph(memory: NativeGraphMemory): NativeGraphHandle
  /**
   * Attaches the memory of one vector store to the core.
   *
   * @param memory - The store's regions and layout.
   * @returns The handle that every later call on this store takes.
   */
  attachStore(memory: NativeStoreMemory): NativeStoreHandle
  /**
   * Releases a store that {@link NativeCore.attachStore} returned.
   *
   * @param store - The store to release.
   * @returns A status code.
   */
  detachStore(store: NativeStoreHandle): number
  /**
   * Finds the nodes nearest to a query by walking the graph.
   *
   * @param graph - The graph to walk.
   * @param store - The store that holds the graph's vectors.
   * @param query - The query vector.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param candidateCount - The number of candidates to keep.
   * @param pin - The write sequence that the search reads the store at, so that it returns only the ordinals that this pin admits.
   * @param threadSlot - The slot of the calling thread.
   * @param ordinals - Receives the ordinal of each candidate.
   * @param distances - Receives the distance of each candidate.
   * @param accepted - A bit set of the ordinals that a search may return, or `null` to accept every ordinal.
   * @returns The number of candidates found.
   */
  search(
    graph: NativeGraphHandle,
    store: NativeStoreHandle,
    query: Float32Array,
    metric: number,
    candidateCount: number,
    pin: number,
    threadSlot: number,
    ordinals: Int32Array,
    distances: Float64Array,
    accepted: Uint8Array | null,
  ): number
  /**
   * Measures the distance from a query to each of the given ordinals.
   *
   * @param store - The store that holds the vectors.
   * @param query - The query vector.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param ordinals - The ordinals to measure.
   * @param count - The number of ordinals to read from `ordinals`.
   * @param pin - The write sequence that the scores read the store at, so that every ordinal that this pin leaves out scores infinity.
   * @param distances - Receives one distance for each ordinal.
   * @returns A status code.
   */
  score(
    store: NativeStoreHandle,
    query: Float32Array,
    metric: number,
    ordinals: Int32Array,
    count: number,
    pin: number,
    distances: Float64Array,
  ): number
  /**
   * Finds the nodes nearest to a query on a native thread, so the calling thread stays free while the core walks
   * the graph. A core without its own threads leaves this out.
   *
   * @param graph - The graph to walk.
   * @param store - The store that holds the graph's vectors.
   * @param query - The query vector, which the core copies before the promise settles.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param candidateCount - The number of candidates to keep.
   * @param pin - The write sequence that the search reads the store at, so that it returns only the ordinals that this pin admits.
   * @param threadSlot - A slot that no other thread uses until the promise settles.
   * @param accepted - A bit set of the ordinals that a search may return, or `null` to accept every ordinal.
   * @returns The candidates found.
   */
  searchAsync?(
    graph: NativeGraphHandle,
    store: NativeStoreHandle,
    query: Float32Array,
    metric: number,
    candidateCount: number,
    pin: number,
    threadSlot: number,
    accepted: Uint8Array | null,
  ): Promise<NativeSearchResult>
  /**
   * Measures the distance from a query to each of the given ordinals on a native thread. A core without its own
   * threads leaves this out.
   *
   * @param store - The store that holds the vectors.
   * @param query - The query vector, which the core copies before the promise settles.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param ordinals - The ordinals to measure, which the core copies before the promise settles.
   * @param count - The number of ordinals to read from `ordinals`.
   * @param pin - The write sequence that the scores read the store at, so that every ordinal that this pin leaves out scores infinity.
   * @param threadSlot - A slot that no other thread uses until the promise settles.
   * @returns The status and one distance for each ordinal.
   */
  scoreAsync?(
    store: NativeStoreHandle,
    query: Float32Array,
    metric: number,
    ordinals: Int32Array,
    count: number,
    pin: number,
    threadSlot: number,
  ): Promise<NativeScoreResult>
  /**
   * Links a new node into the graph.
   *
   * @param graph - The graph to change.
   * @param store - The store that holds the node's vector.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param ordinal - The node to link.
   * @param topLayer - The highest layer that the node joins.
   * @param graphHeldAlone - 1 when the caller holds the graph alone, and 0 otherwise.
   * @param threadSlot - The slot of the calling thread.
   * @param wakes - Receives the count of waiting writers to wake in its first word, followed by their ordinals.
   * @returns A status code.
   */
  place(
    graph: NativeGraphHandle,
    store: NativeStoreHandle,
    metric: number,
    ordinal: number,
    topLayer: number,
    graphHeldAlone: number,
    threadSlot: number,
    wakes: Int32Array,
  ): number
  /**
   * Marks a node as removed and unlinks it from its neighbours.
   *
   * @param graph - The graph to change.
   * @param ordinal - The node to remove.
   * @param threadSlot - The slot of the calling thread.
   * @param wakes - Receives the count of waiting writers to wake in its first word, followed by their ordinals.
   * @returns A status code.
   */
  remove(graph: NativeGraphHandle, ordinal: number, threadSlot: number, wakes: Int32Array): number
  /**
   * Repairs the links of the nodes that pointed at removed nodes.
   *
   * @param graph - The graph to change.
   * @param store - The store that holds the graph's vectors.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param threadSlot - The slot of the calling thread.
   * @param wakes - Receives the count of waiting writers to wake in its first word, followed by their ordinals.
   * @returns A status code.
   */
  compact(
    graph: NativeGraphHandle,
    store: NativeStoreHandle,
    metric: number,
    threadSlot: number,
    wakes: Int32Array,
  ): number
  /**
   * Links the nodes that no other node points at to nearby nodes.
   *
   * @param graph - The graph to change.
   * @param store - The store that holds the graph's vectors.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param nearby - The nodes that the core may link the unreached nodes to.
   * @param threadSlot - The slot of the calling thread.
   * @param wakes - Receives the count of waiting writers to wake in its first word, followed by their ordinals.
   * @returns A status code.
   */
  connectUnreached(
    graph: NativeGraphHandle,
    store: NativeStoreHandle,
    metric: number,
    nearby: Int32Array,
    threadSlot: number,
    wakes: Int32Array,
  ): number
  /**
   * Links the nodes that no other node points at to nearby nodes on a native thread, so the calling thread stays free
   * while the core walks the graph. The call takes the graph lock alone before it returns, and the native thread
   * releases it once the pass ends. Where another thread holds the lock, the call runs no pass and settles with the
   * status that reports the graph as held elsewhere. A core without its own threads leaves this out.
   *
   * @param graph - The graph to change.
   * @param store - The store that holds the graph's vectors.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param nearby - The nodes that the core may link the unreached nodes to, which the core copies before the promise settles.
   * @param threadSlot - A slot that no other thread uses until the promise settles.
   * @returns The status, and the waiting writers to wake.
   */
  connectUnreachedAsync?(
    graph: NativeGraphHandle,
    store: NativeStoreHandle,
    metric: number,
    nearby: Int32Array,
    threadSlot: number,
  ): Promise<NativeConnectResult>
  /**
   * Adds the given vectors to running totals, which the engine uses to calibrate quantisation.
   *
   * @param store - The store that holds the vectors.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param ordinals - The ordinals to add.
   * @param count - The number of ordinals to read from `ordinals`.
   * @param totals - The sum of each axis, then the sum of squared lengths, then the number of vectors.
   * @returns A status code.
   */
  measure(store: NativeStoreHandle, metric: number, ordinals: Int32Array, count: number, totals: Float64Array): number
  /**
   * Writes a quantised code for each of the given ordinals.
   *
   * @param store - The store that holds the vectors.
   * @param metric - The distance metric, where 0 is cosine, 1 is dot product, and 2 is Euclidean.
   * @param ordinals - The ordinals to quantise.
   * @param count - The number of ordinals to read from `ordinals`.
   * @returns A status code.
   */
  quantise(store: NativeStoreHandle, metric: number, ordinals: Int32Array, count: number): number
}
