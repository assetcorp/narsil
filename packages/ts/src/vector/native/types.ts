import type { NativeAnalysisCore } from './analysis-types'

/**
 * The regions of one HNSW graph that the native search core reads and writes.
 *
 * @internal
 */
export interface NativeGraphMemory {
  /** The graph's header words, which hold the entry point, the top layer, the link limits, the counts, and the graph lock. */
  graphHeader: Int32Array
  /** The top layer of each node, one byte for each ordinal. */
  nodeLevels: Uint8Array
  /** The neighbour lists on layer 0, a fixed number of words for each ordinal. */
  level0: Int32Array
  /** The position in {@link NativeGraphMemory.upper} where each node's upper-layer lists start, one word for each ordinal. */
  upperBase: Int32Array
  /** The neighbour lists on every layer above layer 0. */
  upper: Int32Array
  /** One lock word for each node, which a writer takes before it changes that node's lists. */
  locks: Int32Array
  /** One byte for each ordinal, which the core sets once it removes that node. */
  tombstones: Uint8Array
  /** The number of neighbour lists that hold each node, one word for each ordinal. */
  incoming: Int32Array
  /** One byte for each ordinal, which the core sets when that node's links have to be checked again. */
  nearestLinkDue: Uint8Array
  /** The locks that each thread slot holds, 32 words for each slot. */
  heldLocks: Int32Array
}

/**
 * The regions and layout of one vector store that the native search core reads.
 *
 * @internal
 */
export interface NativeStoreMemory {
  /** The store's header words, which hold the slot count, the live count, and the calibration state. */
  storeHeader: Int32Array
  /** The number of values in each vector. */
  dimension: number
  /** The number of bits for each value in a quantised code, or 0 when the store keeps no codes. */
  bits: number
  /** The number of quantised records that each code block holds. */
  recordsPerBlock: number
  /** The number of full-precision vectors that each vector block holds. */
  vectorsPerBlock: number
  /** The number of bytes from the start of one vector to the start of the next in a vector block. */
  vectorStrideBytes: number
  /** One byte for each ordinal, set when that ordinal has a quantised code. */
  codePresent: Uint8Array
  /** The mean vector that the quantised codes are measured from. */
  centroid: Float32Array
  /** The length of each full-precision vector, one value for each ordinal. */
  magnitudes: Float64Array
  /** One byte for each ordinal, set when that ordinal holds a vector. */
  present: Uint8Array
  /** For each ordinal, the position in {@link NativeStoreMemory.vectorFiles} of the file that holds its vector, or -1 when the vector is in a block. */
  vectorFile: Int32Array
  /** For each ordinal whose vector is in a file, the vector's offset within that file. */
  vectorOffset: Uint32Array
  /** The paths of the files that hold full-precision vectors. */
  vectorFiles: string[]
  /** The blocks of quantised codes, in ordinal order. */
  codeBlocks: Uint8Array[]
  /** The blocks of full-precision vectors, in ordinal order, with `null` in place of a block that the store holds no memory for. */
  vectorBlocks: Array<Uint8Array | null>
}

/**
 * A graph that the native search core has attached.
 *
 * @internal
 */
export type NativeGraphHandle = object

/**
 * A vector store that the native search core has attached.
 *
 * @internal
 */
export type NativeStoreHandle = object

/**
 * The candidates that a search on a native thread found.
 *
 * @internal
 */
export interface NativeSearchResult {
  /** The number of candidates found, or a negative status code when the search failed. */
  count: number
  /** The ordinal of each candidate, of which the first `count` entries hold results. */
  ordinals: Int32Array
  /** The distance of each candidate, in the same order as {@link NativeSearchResult.ordinals}. */
  distances: Float64Array
}

/**
 * The distances that a scoring call on a native thread measured.
 *
 * @internal
 */
export interface NativeScoreResult {
  /** A status code from the core's header. */
  status: number
  /** One distance for each ordinal that the call measured. */
  distances: Float64Array
}

/**
 * The outcome of a connecting pass that ran on a native thread.
 *
 * @internal
 */
export interface NativeConnectResult {
  /** A status code from the core's header. */
  status: number
  /** The count of waiting writers to wake in its first word, followed by their ordinals. */
  wakes: Int32Array
}

export const NATIVE_CORE_ABI_VERSION = 7
export const NATIVE_OK = 0
export const NATIVE_NEEDS_ROOM = 3
export const NATIVE_GRAPH_NOT_HELD_ALONE = 4

/**
 * The operations of the native search core, which each return a status code from the core's header, or, for a
 * search, the number of candidates found.
 *
 * @internal
 */
export interface NativeCore extends NativeAnalysisCore {
  /** Returns the version of the core's binary interface, which the engine compares with the version that it was built for. */
  abiVersion(): number
  /** Returns the number of bytes that the core's working memory holds. */
  workspaceBytes(): number
  /**
   * Applies one of the core's maths functions to every entry of an array, giving the same bits as the
   * functions under `src/math` on every platform.
   *
   * @param operation - The function's index from the core's header: log, sin, cos, tan, asin, atan, or atan2.
   * @param first - The arguments, or the rise of each angle for atan2.
   * @param second - The run of each angle for atan2, ignored by every other function.
   * @param results - The array that receives one result for each argument.
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
   * @param distances - Receives one distance for each ordinal.
   * @returns A status code.
   */
  score(
    store: NativeStoreHandle,
    query: Float32Array,
    metric: number,
    ordinals: Int32Array,
    count: number,
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
   * @param threadSlot - A slot that no other thread uses until the promise settles.
   * @returns The status and one distance for each ordinal.
   */
  scoreAsync?(
    store: NativeStoreHandle,
    query: Float32Array,
    metric: number,
    ordinals: Int32Array,
    count: number,
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
