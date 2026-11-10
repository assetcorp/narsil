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
  /** For each ordinal, the sequence of the write that added its vector. */
  bornAt: BigInt64Array
  /** For each ordinal, the sequence of the write that removed or replaced its document, or 0. */
  retiredAt: BigInt64Array
  /** For each thread slot, the oldest pin that the thread holds plus 1, or 0. */
  pins: BigInt64Array
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
