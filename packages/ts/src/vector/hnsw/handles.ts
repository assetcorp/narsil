import type { VectorMetric } from '../brute-force'
import { MAX_VECTOR_ORDINALS, VECTOR_SCRATCH_SLOTS, VECTOR_STORE_INITIAL_CAPACITY } from '../constants'
import { createGrowableBuffer, type GrowableBuffer } from '../shared-buffers/growable'
import { INITIAL_UPPER_SLOTS } from './constants'

export const GRAPH_ENTRY_POINT = 0
export const GRAPH_TOP_LAYER = 1
export const GRAPH_M = 2
export const GRAPH_MMAX0 = 3
export const GRAPH_EF_CONSTRUCTION = 4
export const GRAPH_METRIC = 5
export const GRAPH_NODE_COUNT = 32
export const GRAPH_TOMBSTONE_COUNT = 33
export const GRAPH_UPPER_USED = 64
export const GRAPH_SLOTS = 65
export const GRAPH_LOCK = 96
export const GRAPH_WRITERS_WAITING = 97
export const GRAPH_ENTRY_LOCK = 128
const GRAPH_HEADER_WORDS = 160

export const HELD_WRITE = 0
export const HELD_WRITE_VERSION = 1
export const HELD_GRAPH = 2
export const HELD_FENCE = 3
export const HELD_GRAPH_WAITING = 4
export const HELD_WORDS_PER_THREAD = 32

const METRIC_CODES: readonly VectorMetric[] = ['cosine', 'dotProduct', 'euclidean']

/**
 * A thread opens these handles so that it can search or extend one graph in
 * place. They name the counters every thread reads through atomics, the
 * adjacency arrays that grow without moving, the lock word of every node, and
 * the record of the locks each thread holds, which the main thread reads to
 * release what a dead thread left behind.
 *
 * @internal
 */
export interface SharedGraphHandles {
  /** This holds the entry point, the layer count, the node counts, the arena cursor, and the graph's shape. */
  header: Int32Array
  /** This holds each ordinal's top layer plus one, and it reads zero where the graph holds no node there. */
  nodeLevels: GrowableBuffer
  /** This holds the base layer's neighbours, a count followed by that many neighbours for each ordinal. */
  level0: GrowableBuffer
  /** This holds where each ordinal's upper layers start plus one, and it reads zero where the ordinal reaches none. */
  upperBase: GrowableBuffer
  /** This holds every upper layer's neighbours, a count followed by that many neighbours for each layer. */
  upper: GrowableBuffer
  /** This holds one lock word per ordinal. */
  locks: GrowableBuffer
  /** This holds one byte per ordinal, which reads 1 once a caller removes the document. */
  tombstones: GrowableBuffer
  /** This records the node lock and the graph lock each thread slot holds right now. */
  heldLocks: Int32Array
}

/**
 * The graph keeps this shape from the moment a caller creates it, and every
 * thread reads it back out of the header.
 *
 * @internal
 */
export interface SharedGraphShape {
  /** Each node keeps this many neighbours on an upper layer. */
  m: number
  /** Each node keeps this many neighbours on the base layer. */
  mMax0: number
  /** The builder explores this many candidates while placing each node. */
  efConstruction: number
  /** The graph ranks by this metric. */
  metric: VectorMetric
}

function perOrdinal(bytesPerOrdinal: number, initialOrdinals: number): GrowableBuffer {
  return createGrowableBuffer(initialOrdinals * bytesPerOrdinal, MAX_VECTOR_ORDINALS * bytesPerOrdinal)
}

/**
 * Allocates the handles of an empty graph.
 *
 * @param shape The graph's shape, which every thread reads back from the header.
 * @returns The handles.
 *
 * @internal
 */
export function createSharedGraphHandles(shape: SharedGraphShape): SharedGraphHandles {
  const header = new Int32Array(createGrowableBuffer(GRAPH_HEADER_WORDS * 4, GRAPH_HEADER_WORDS * 4))
  header[GRAPH_ENTRY_POINT] = -1
  header[GRAPH_TOP_LAYER] = -1
  header[GRAPH_M] = shape.m
  header[GRAPH_MMAX0] = shape.mMax0
  header[GRAPH_EF_CONSTRUCTION] = shape.efConstruction
  header[GRAPH_METRIC] = Math.max(0, METRIC_CODES.indexOf(shape.metric))
  const level0Stride = shape.mMax0 + 2
  const upperStride = shape.m + 2
  const heldWords = VECTOR_SCRATCH_SLOTS * HELD_WORDS_PER_THREAD

  return {
    header,
    nodeLevels: perOrdinal(1, VECTOR_STORE_INITIAL_CAPACITY),
    level0: perOrdinal(level0Stride * 4, VECTOR_STORE_INITIAL_CAPACITY),
    upperBase: perOrdinal(4, VECTOR_STORE_INITIAL_CAPACITY),
    upper: perOrdinal(upperStride * 4, INITIAL_UPPER_SLOTS),
    locks: perOrdinal(4, VECTOR_STORE_INITIAL_CAPACITY),
    tombstones: perOrdinal(1, VECTOR_STORE_INITIAL_CAPACITY),
    heldLocks: new Int32Array(createGrowableBuffer(heldWords * 4, heldWords * 4)),
  }
}

/**
 * Reads the graph shape back from a header.
 *
 * @param header The header to read.
 * @returns The shape that header records.
 *
 * @internal
 */
export function graphShapeOf(header: Int32Array): SharedGraphShape {
  return {
    m: header[GRAPH_M],
    mMax0: header[GRAPH_MMAX0],
    efConstruction: header[GRAPH_EF_CONSTRUCTION],
    metric: METRIC_CODES[header[GRAPH_METRIC]] ?? 'cosine',
  }
}
