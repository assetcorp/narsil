import { createVectorFileReader, type VectorFileReader } from '#platform/vector-file'
import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import { fixedView } from '../shared-buffers/growable'
import { arenaFloat32Distance } from '../simd'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from '../similarity'
import { NOTHING_STAGED, type OpenVectorBlock, openVectorBlock, QUERY_STAGED, slotByteOffset } from './blocks'
import {
  IN_MEMORY,
  type SharedVectorStoreHandles,
  STORE_BLOCK_COUNT,
  STORE_CODE_BLOCK_COUNT,
  STORE_SLOTS,
} from './handles'
import type { ArenaQueryVector, VectorStoreEntry } from './types'

const decoder = new TextDecoder()

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
  /** Reports whether a checkpoint file holds an ordinal's vector. */
  isCold(ordinal: number): boolean
  entryForOrdinal(ordinal: number): VectorStoreEntry | undefined
  /** Reads an ordinal's vector, which for a released ordinal is a fresh copy read from its file. */
  vectorAt(ordinal: number): Float32Array
  magnitudeAt(ordinal: number): number
  docIdAt(ordinal: number): string | undefined
  partitionAt(ordinal: number): number | undefined
  distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number
  prepareQueryArena(query: Float32Array): ArenaQueryVector | null
  distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number
  blockOf(ordinal: number): OpenVectorBlock
  localOrdinal(ordinal: number): number
  /** Opens the code block holding an ordinal's record, which every code block of the field must exist for. */
  codeBlockOf(ordinal: number): OpenVectorBlock
  codeLocalOrdinal(ordinal: number): number
  /** Reports the code blocks this thread has opened, so a query can reset what it staged in each. */
  openCodeBlocks(): Iterable<OpenVectorBlock>
  /** Reads a released ordinal's vector from its file into the given target, and reports false where the file is gone. */
  readColdInto(ordinal: number, target: Float32Array): boolean
  /** Reads a vector at a byte offset of one of the store's files into the target, and reports false where the file is gone. */
  readFromFile(fileIndex: number, offset: number, target: Float32Array): boolean
  /** Closes every file descriptor this thread opened for released vectors. */
  close(): void
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

export function openSharedVectorStore(initial: SharedVectorStoreHandles, threadSlot: number): SharedVectorStoreView {
  let handles = initial
  const { dimension, layout } = initial
  const capacity = layout.capacity
  const codeCapacity = initial.codeLayout?.capacity ?? 1
  const blocks: Array<OpenVectorBlock | undefined> = []
  const codeBlocks: OpenVectorBlock[] = []
  let present = fixedView(handles.present, Uint8Array)
  let magnitudes = fixedView(handles.magnitudes, Float64Array)
  let partitions = fixedView(handles.partitions, Int32Array)
  let docIdBytes = fixedView(handles.docIdBytes, Uint8Array)
  let docIdOffsets = fixedView(handles.docIdOffsets, Uint32Array)
  let diskFile = fixedView(handles.diskFile, Int32Array)
  let diskOffset = fixedView(handles.diskOffset, Uint32Array)
  let currentQuery: Float32Array | null = null
  let reader: VectorFileReader | null = null
  const coldScratchA = new Float32Array(dimension)
  const coldScratchB = new Float32Array(dimension)

  function rebind(): void {
    present = fixedView(handles.present, Uint8Array)
    magnitudes = fixedView(handles.magnitudes, Float64Array)
    partitions = fixedView(handles.partitions, Int32Array)
    docIdBytes = fixedView(handles.docIdBytes, Uint8Array)
    docIdOffsets = fixedView(handles.docIdOffsets, Uint32Array)
    diskFile = fixedView(handles.diskFile, Int32Array)
    diskOffset = fixedView(handles.diskOffset, Uint32Array)
  }

  function blockAt(index: number): OpenVectorBlock {
    let block = blocks[index]
    if (block === undefined) {
      const handle = handles.blocks[index]
      if (handle === null || handle === undefined) {
        throw new Error(`Vector block ${index} holds no vectors on this thread`)
      }
      block = openVectorBlock(handle, threadSlot)
      blocks[index] = block
    }
    return block
  }

  function codeBlockAt(index: number): OpenVectorBlock {
    let block = codeBlocks[index]
    if (block === undefined) {
      block = openVectorBlock(handles.codeBlocks[index], threadSlot)
      codeBlocks[index] = block
    }
    return block
  }

  function fileOf(ordinal: number): number {
    if (ordinal >= diskFile.length) {
      if (ordinal * 4 >= handles.diskFile.byteLength) return IN_MEMORY
      rebind()
    }
    return diskFile[ordinal]
  }

  function isCold(ordinal: number): boolean {
    return fileOf(ordinal) !== IN_MEMORY
  }

  function holds(ordinal: number): boolean {
    if (ordinal < 0) return false
    if (ordinal >= present.length) {
      if (ordinal >= handles.present.byteLength) return false
      rebind()
    }
    if (present[ordinal] !== 1) return false
    if (isCold(ordinal)) return true
    const index = Math.floor(ordinal / capacity)
    return index < handles.blocks.length && handles.blocks[index] !== null
  }

  function readFromFile(file: number, offset: number, target: Float32Array): boolean {
    const path = handles.vectorFiles[file]
    if (path === undefined || path.length === 0) return false
    if (reader === null) reader = createVectorFileReader()
    const bytes = new Uint8Array(target.buffer, target.byteOffset, target.byteLength)
    return reader.readInto(path, offset, bytes)
  }

  function readColdInto(ordinal: number, target: Float32Array): boolean {
    const file = fileOf(ordinal)
    if (file === IN_MEMORY) return false
    if (ordinal >= diskOffset.length) rebind()
    return readFromFile(file, diskOffset[ordinal], target)
  }

  function vectorIn(block: OpenVectorBlock, local: number): Float32Array {
    const base = slotByteOffset(layout, local) / 4
    return block.float32(base + dimension).subarray(base, base + dimension)
  }

  function hotVector(ordinal: number): Float32Array {
    return vectorIn(blockAt((ordinal / capacity) | 0), ordinal % capacity)
  }

  function vectorFor(ordinal: number, scratch: Float32Array): Float32Array | null {
    if (!isCold(ordinal)) return hotVector(ordinal)
    return readColdInto(ordinal, scratch) ? scratch : null
  }

  function stageVector(block: OpenVectorBlock, ordinal: number): boolean {
    if (block.stagedOrdinal === ordinal) return true
    const source = vectorFor(ordinal, coldScratchA)
    if (source === null) return false
    block.float32(0).set(source, block.scratchByteOffset / 4)
    block.stagedOrdinal = ordinal
    return true
  }

  function stageQuery(block: OpenVectorBlock): boolean {
    if (currentQuery === null) return false
    if (block.stagedOrdinal !== QUERY_STAGED) {
      block.float32(0).set(currentQuery, block.scratchByteOffset / 4)
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
      const first = handles.blocks.find(block => block !== null)
      if (first === undefined) return false
      const block = blockAt(handles.blocks.indexOf(first))
      return block.simd !== null && block.hasScratch
    },
    get holdsEveryBlock() {
      return (
        Atomics.load(handles.header, STORE_BLOCK_COUNT) <= handles.blocks.length &&
        Atomics.load(handles.header, STORE_CODE_BLOCK_COUNT) <= handles.codeBlocks.length
      )
    },

    adoptHandles(next) {
      handles = next
      rebind()
      for (let index = 0; index < next.blocks.length; index++) {
        if (next.blocks[index] === null) blocks[index] = undefined
        else if (blocks[index] === undefined) blockAt(index)
      }
      for (let index = codeBlocks.length; index < next.codeBlocks.length; index++) codeBlockAt(index)
      reader?.retainOnly(new Set(next.vectorFiles.filter(path => path.length > 0)))
    },

    rebind,
    holdsOrdinal: holds,
    isCold,
    readColdInto,
    readFromFile,

    close() {
      reader?.close()
      reader = null
    },

    blockOf(ordinal) {
      return blockAt((ordinal / capacity) | 0)
    },

    localOrdinal(ordinal) {
      return ordinal % capacity
    },

    codeBlockOf(ordinal) {
      return codeBlockAt((ordinal / codeCapacity) | 0)
    },

    codeLocalOrdinal(ordinal) {
      return ordinal % codeCapacity
    },

    openCodeBlocks() {
      return codeBlocks
    },

    vectorAt(ordinal) {
      if (!isCold(ordinal)) return hotVector(ordinal)
      const copy = new Float32Array(dimension)
      if (!readColdInto(ordinal, copy)) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_LOAD_FAILED,
          `The vector at ordinal ${ordinal} is missing from its checkpoint file`,
          { ordinal, path: handles.vectorFiles[fileOf(ordinal)] },
        )
      }
      return copy
    },

    magnitudeAt(ordinal) {
      if (ordinal >= magnitudes.length) rebind()
      return magnitudes[ordinal]
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
      if (!isCold(ordB)) {
        const indexA = (ordA / capacity) | 0
        const indexB = (ordB / capacity) | 0
        const blockB = blockAt(indexB)
        const localB = ordB % capacity
        if (blockB.simd !== null) {
          if (indexA === indexB && !isCold(ordA)) {
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
          if (blockB.hasScratch && stageVector(blockB, ordA)) {
            return arenaFloat32Distance(
              blockB.simd,
              blockB.scratchByteOffset,
              slotByteOffset(layout, localB),
              dimension,
              metric,
              magnitudes[ordA],
              magnitudes[ordB],
            )
          }
        }
      }
      const a = vectorFor(ordA, coldScratchA)
      const b = vectorFor(ordB, coldScratchB)
      if (a === null || b === null) return Number.POSITIVE_INFINITY
      return jsDistance(a, b, magnitudes[ordA], magnitudes[ordB], metric)
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
      if (currentQuery === null) return Number.POSITIVE_INFINITY
      if (isCold(ordinal)) {
        if (!readColdInto(ordinal, coldScratchA)) return Number.POSITIVE_INFINITY
        return jsDistance(currentQuery, coldScratchA, prepared.magnitude, magnitudes[ordinal], metric)
      }
      const block = blockAt((ordinal / capacity) | 0)
      const local = ordinal % capacity
      if (block.simd !== null && block.hasScratch && stageQuery(block)) {
        return arenaFloat32Distance(
          block.simd,
          block.scratchByteOffset,
          slotByteOffset(layout, local),
          dimension,
          metric,
          prepared.magnitude,
          magnitudes[ordinal],
        )
      }
      return jsDistance(currentQuery, vectorIn(block, local), prepared.magnitude, magnitudes[ordinal], metric)
    },
  }

  for (let index = 0; index < handles.blocks.length; index++) {
    if (handles.blocks[index] !== null) blockAt(index)
  }
  for (let index = 0; index < handles.codeBlocks.length; index++) codeBlockAt(index)
  return view
}
