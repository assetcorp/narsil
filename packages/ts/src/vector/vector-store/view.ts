import type { VectorFileReader } from '#platform/vector-file'
import {
  arenaFloat32Distance,
  createVectorFileReader,
  detachNativeStore,
  ErrorCodes,
  fixedView,
  IN_MEMORY,
  magnitude,
  NarsilError,
  NOTHING_STAGED,
  openVectorBlock,
  QUERY_STAGED,
  STORE_BLOCK_COUNT,
  STORE_CODE_BLOCK_COUNT,
  STORE_SLOTS,
  slotByteOffset,
} from '#platform/vector-host'
import type { OpenVectorBlock } from './blocks'
import type { SharedVectorStoreHandles } from './handles'
import {
  distanceFromQueryOf,
  type HotBlockReads,
  jsDistance,
  ordinalDistanceOf,
  pairDistanceOf,
  queryDistanceOf,
} from './hot-block-distance'
import type { SharedVectorStoreView } from './view-types'

const decoder = new TextDecoder()

const NOT_HELD = 0
const HELD_COLD = 1
const HELD_HOT = 2

export type { SharedVectorStoreView } from './view-types'

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

  const isCold = (ordinal: number): boolean => fileOf(ordinal) !== IN_MEMORY

  function holdState(ordinal: number): number {
    if (ordinal < 0) return NOT_HELD
    if (ordinal >= present.length) {
      if (ordinal >= handles.present.byteLength) return NOT_HELD
      rebind()
    }
    if (present[ordinal] !== 1) return NOT_HELD
    if (isCold(ordinal)) return HELD_COLD
    const index = Math.floor(ordinal / capacity)
    return index < handles.blocks.length && handles.blocks[index] !== null ? HELD_HOT : NOT_HELD
  }

  const holds = (ordinal: number): boolean => holdState(ordinal) !== NOT_HELD

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
    block.float32(block.scratchByteOffset / 4 + dimension).set(source, block.scratchByteOffset / 4)
    block.stagedOrdinal = ordinal
    return true
  }

  function hotBlockReads(): HotBlockReads | null {
    const handle = handles.blocks[0]
    if (handle === null || handle === undefined) return null
    const { slotsOffset, slotStride } = layout
    const limit = Math.min(present.length, diskFile.length, magnitudes.length, capacity)
    return { block: blockAt(0), present, diskFile, magnitudes, limit, slotsOffset, slotStride, dimension }
  }

  function stageQuery(block: OpenVectorBlock): boolean {
    if (currentQuery === null) return false
    if (block.stagedOrdinal !== QUERY_STAGED) {
      block.float32(block.scratchByteOffset / 4 + dimension).set(currentQuery, block.scratchByteOffset / 4)
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
      detachNativeStore(handles)
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
      detachNativeStore(handles)
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
      const state = holdState(ordinal)
      if (state === NOT_HELD) return Number.POSITIVE_INFINITY
      if (currentQuery === null) return Number.POSITIVE_INFINITY
      if (state === HELD_COLD) {
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

    distanceFromQuery: (query, queryMagnitude, ordinal, metric) =>
      distanceFromQueryOf(view, coldScratchB, query, queryMagnitude, ordinal, metric),
    hotBlockReads,
    queryDistance: (prepared, metric) => queryDistanceOf(view, prepared, metric),
    ordinalDistance: (from, metric) => ordinalDistanceOf(view, from, metric),
    pairDistance: metric => pairDistanceOf(view, metric),
  }

  for (let index = 0; index < handles.blocks.length; index++) {
    if (handles.blocks[index] !== null) blockAt(index)
  }
  for (let index = 0; index < handles.codeBlocks.length; index++) codeBlockAt(index)
  return view
}
