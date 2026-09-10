import type { VectorMetric } from '../brute-force'
import { fixedView } from '../shared-buffers/growable'
import { arenaFloat32Distance } from '../simd'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from '../similarity'
import { NOTHING_STAGED, type OpenVectorBlock, openVectorBlock, QUERY_STAGED, slotByteOffset } from './blocks'
import { type SharedVectorStoreHandles, STORE_BLOCK_COUNT, STORE_SLOTS } from './handles'
import type { ArenaQueryVector, VectorStoreEntry } from './types'

const decoder = new TextDecoder()

/**
 * This is one thread's reader over a field's shared vectors, holding the
 * blocks the thread has opened, the side tables that grow in place, and the
 * scratch the thread stages a query or a vector into before a kernel measures
 * against it.
 *
 * @internal
 */
export interface SharedVectorStoreView {
  readonly dimension: number
  readonly threadSlot: number
  readonly handles: SharedVectorStoreHandles
  readonly slots: number
  readonly simdAvailable: boolean
  /** Reports whether this thread has opened every block the field holds, which reads false until the main thread sends the handles of a block it has added. */
  readonly holdsEveryBlock: boolean
  adoptHandles(handles: SharedVectorStoreHandles): void
  /** Rebuilds the views over the side tables once the main thread has grown them. */
  rebind(): void
  holdsOrdinal(ordinal: number): boolean
  entryForOrdinal(ordinal: number): VectorStoreEntry | undefined
  vectorAt(ordinal: number): Float32Array
  magnitudeAt(ordinal: number): number
  codesAt(ordinal: number): Uint8Array
  docIdAt(ordinal: number): string | undefined
  partitionAt(ordinal: number): number | undefined
  distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number
  prepareQueryArena(query: Float32Array): ArenaQueryVector | null
  distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number
  blockOf(ordinal: number): OpenVectorBlock
  localOrdinal(ordinal: number): number
}

function jsDistance(a: Float32Array, b: Float32Array, magA: number, magB: number, metric: VectorMetric): number {
  switch (metric) {
    case 'cosine':
      return 1 - cosineSimilarityWithMagnitudes(a, b, magA, magB)
    case 'dotProduct':
      return -dotProduct(a, b)
    case 'euclidean':
      return euclideanDistance(a, b)
  }
}

/**
 * Opens a field's shared vectors on the current thread.
 *
 * @param initial The handles to open.
 * @param threadSlot This thread's scratch slot inside every block.
 * @returns The reader.
 *
 * @internal
 */
export function openSharedVectorStore(initial: SharedVectorStoreHandles, threadSlot: number): SharedVectorStoreView {
  let handles = initial
  const { dimension, layout } = initial
  const capacity = layout.capacity
  const blocks: OpenVectorBlock[] = []
  let magnitudes = fixedView(handles.magnitudes, Float64Array)
  let present = fixedView(handles.present, Uint8Array)
  let partitions = fixedView(handles.partitions, Int32Array)
  let docIdBytes = fixedView(handles.docIdBytes, Uint8Array)
  let docIdOffsets = fixedView(handles.docIdOffsets, Uint32Array)
  let currentQuery: Float32Array | null = null

  function rebind(): void {
    magnitudes = fixedView(handles.magnitudes, Float64Array)
    present = fixedView(handles.present, Uint8Array)
    partitions = fixedView(handles.partitions, Int32Array)
    docIdBytes = fixedView(handles.docIdBytes, Uint8Array)
    docIdOffsets = fixedView(handles.docIdOffsets, Uint32Array)
  }

  function blockAt(index: number): OpenVectorBlock {
    let block = blocks[index]
    if (block === undefined) {
      block = openVectorBlock(handles.blocks[index], threadSlot)
      blocks[index] = block
    }
    return block
  }

  function holds(ordinal: number): boolean {
    if (ordinal < 0) return false
    if (ordinal >= present.length) {
      if (ordinal >= handles.present.byteLength) return false
      rebind()
    }
    if (present[ordinal] !== 1) return false
    return Math.floor(ordinal / capacity) < handles.blocks.length
  }

  function vectorIn(block: OpenVectorBlock, local: number): Float32Array {
    const base = slotByteOffset(layout, local) / 4
    return block.float32(base + dimension).subarray(base, base + dimension)
  }

  function stageVector(block: OpenVectorBlock, ordinal: number): void {
    if (block.stagedOrdinal === ordinal) return
    const source = vectorIn(blockAt((ordinal / capacity) | 0), ordinal % capacity)
    block.float32(0).set(source, block.float32ScratchByteOffset / 4)
    block.stagedOrdinal = ordinal
  }

  function stageQuery(block: OpenVectorBlock): boolean {
    if (currentQuery === null) return false
    if (block.stagedOrdinal !== QUERY_STAGED) {
      block.float32(0).set(currentQuery, block.float32ScratchByteOffset / 4)
      block.stagedOrdinal = QUERY_STAGED
    }
    return true
  }

  const view: SharedVectorStoreView = {
    dimension,
    threadSlot,
    get handles() {
      return handles
    },
    get slots() {
      return Atomics.load(handles.header, STORE_SLOTS)
    },
    get simdAvailable() {
      return handles.blocks.length > 0 && blockAt(0).simd !== null && blockAt(0).hasScratch
    },
    get holdsEveryBlock() {
      return Atomics.load(handles.header, STORE_BLOCK_COUNT) <= handles.blocks.length
    },

    adoptHandles(next) {
      handles = next
      rebind()
      for (let index = blocks.length; index < next.blocks.length; index++) blockAt(index)
    },

    rebind,
    holdsOrdinal: holds,

    blockOf(ordinal) {
      return blockAt((ordinal / capacity) | 0)
    },

    localOrdinal(ordinal) {
      return ordinal % capacity
    },

    vectorAt(ordinal) {
      return vectorIn(blockAt((ordinal / capacity) | 0), ordinal % capacity)
    },

    magnitudeAt(ordinal) {
      if (ordinal >= magnitudes.length) rebind()
      return magnitudes[ordinal]
    },

    codesAt(ordinal) {
      const block = blockAt((ordinal / capacity) | 0)
      const base = slotByteOffset(layout, ordinal % capacity) + layout.codeOffsetInSlot
      return block.bytes(base + dimension).subarray(base, base + dimension)
    },

    entryForOrdinal(ordinal) {
      if (!holds(ordinal)) return undefined
      return { vector: view.vectorAt(ordinal), magnitude: magnitudes[ordinal] }
    },

    docIdAt(ordinal) {
      if (ordinal < 0 || ordinal >= view.slots) return undefined
      if (ordinal + 1 >= docIdOffsets.length) rebind()
      const start = docIdOffsets[ordinal]
      const end = docIdOffsets[ordinal + 1]
      if (end <= start) return undefined
      if (end > docIdBytes.length) rebind()
      return decoder.decode(docIdBytes.subarray(start, end))
    },

    partitionAt(ordinal) {
      if (ordinal < 0) return undefined
      if (ordinal >= partitions.length) {
        if (ordinal * 4 >= handles.partitions.byteLength) return undefined
        rebind()
      }
      const partition = partitions[ordinal]
      return partition < 0 ? undefined : partition
    },

    distanceByOrdinal(ordA, ordB, metric) {
      if (!holds(ordA) || !holds(ordB)) return Number.POSITIVE_INFINITY
      const indexA = (ordA / capacity) | 0
      const indexB = (ordB / capacity) | 0
      const blockB = blockAt(indexB)
      const localB = ordB % capacity
      if (blockB.simd !== null) {
        if (indexA === indexB) {
          return arenaFloat32Distance(
            blockB.simd,
            slotByteOffset(layout, ordA % capacity),
            slotByteOffset(layout, localB),
            dimension,
            metric,
            magnitudes[ordA],
            magnitudes[ordB],
          )
        }
        if (blockB.hasScratch) {
          stageVector(blockB, ordA)
          return arenaFloat32Distance(
            blockB.simd,
            blockB.float32ScratchByteOffset,
            slotByteOffset(layout, localB),
            dimension,
            metric,
            magnitudes[ordA],
            magnitudes[ordB],
          )
        }
      }
      return jsDistance(view.vectorAt(ordA), vectorIn(blockB, localB), magnitudes[ordA], magnitudes[ordB], metric)
    },

    prepareQueryArena(query) {
      if (query.length !== dimension || !view.simdAvailable) return null
      currentQuery = query
      for (const block of blocks) {
        if (block !== undefined) block.stagedOrdinal = NOTHING_STAGED
      }
      return { magnitude: magnitude(query) }
    },

    distanceFromArena(prepared, ordinal, metric) {
      if (!holds(ordinal)) return Number.POSITIVE_INFINITY
      const block = blockAt((ordinal / capacity) | 0)
      const local = ordinal % capacity
      if (block.simd !== null && block.hasScratch && stageQuery(block)) {
        return arenaFloat32Distance(
          block.simd,
          block.float32ScratchByteOffset,
          slotByteOffset(layout, local),
          dimension,
          metric,
          prepared.magnitude,
          magnitudes[ordinal],
        )
      }
      if (currentQuery === null) return Number.POSITIVE_INFINITY
      return jsDistance(currentQuery, vectorIn(block, local), prepared.magnitude, magnitudes[ordinal], metric)
    },
  }

  for (let index = 0; index < handles.blocks.length; index++) blockAt(index)
  return view
}
