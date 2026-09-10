import { MAX_WASM_PAGES, VECTOR_BLOCK_INITIAL_SLOTS, VECTOR_SCRATCH_SLOTS, WASM_PAGE_BYTES } from '../constants'
import {
  createGrowableBuffer,
  fixedView,
  type GrowableBuffer,
  growBufferTo,
  nextGrowthTarget,
  sharedMemoryAvailable,
} from '../shared-buffers/growable'
import { type ArenaSimd, createArenaSimd, createSharedArenaSimd } from '../simd'

const SCRATCH_ALIGNMENT_BYTES = 16
const BLOCK_MAX_BYTES = MAX_WASM_PAGES * WASM_PAGE_BYTES

function alignUp(bytes: number): number {
  return Math.ceil(bytes / SCRATCH_ALIGNMENT_BYTES) * SCRATCH_ALIGNMENT_BYTES
}

/**
 * This layout gives the byte offset of every region inside one vector block.
 *
 * A block begins with one float32 query scratch and one code query scratch
 * for each thread slot, and the vector slots follow them. Each slot holds one
 * vector's float32 components, followed by its byte codes where the field is
 * quantised, so the memory a block takes grows with the vectors written into
 * it.
 *
 * @internal
 */
export interface VectorBlockLayout {
  /** Every vector of the field has this many components. */
  dimension: number
  /** Each slot reserves room for the vector's byte codes when this reads true. */
  quantized: boolean
  /** Each thread's float32 query scratch spans this many bytes. */
  float32ScratchStride: number
  /** Each thread's code query scratch spans this many bytes. */
  codeScratchStride: number
  /** The code query scratch slots start at this byte offset. */
  codeScratchOffset: number
  /** The vector slots start at this byte offset. */
  slotsOffset: number
  /** Each vector slot spans this many bytes. */
  slotStride: number
  /** A slot's byte codes start this many bytes into the slot. */
  codeOffsetInSlot: number
  /** The block holds this many vector slots at most. */
  capacity: number
}

/**
 * Computes the layout every block of a field follows, from the dimension and
 * from whether each slot keeps the vector's codes beside it.
 *
 * @param dimension The number of components per vector.
 * @param quantized Whether each slot also holds the vector's byte codes.
 * @returns The layout every block of the field follows.
 *
 * @internal
 */
export function computeVectorBlockLayout(dimension: number, quantized: boolean): VectorBlockLayout {
  const float32ScratchStride = alignUp(dimension * 4)
  const codeScratchStride = alignUp(dimension)
  const codeScratchOffset = VECTOR_SCRATCH_SLOTS * float32ScratchStride
  const slotsOffset = alignUp(codeScratchOffset + VECTOR_SCRATCH_SLOTS * codeScratchStride)
  const codeOffsetInSlot = dimension * 4
  const slotStride = alignUp(codeOffsetInSlot + (quantized ? dimension : 0))
  return {
    dimension,
    quantized,
    float32ScratchStride,
    codeScratchStride,
    codeScratchOffset,
    slotsOffset,
    slotStride,
    codeOffsetInSlot,
    capacity: Math.floor((BLOCK_MAX_BYTES - slotsOffset) / slotStride),
  }
}

/**
 * One block keeps its bytes in a shared WebAssembly memory that every thread
 * binds the distance kernels to, in a private WebAssembly memory where the
 * runtime shares no memory, or in plain bytes where the runtime offers no
 * WebAssembly.
 *
 * @internal
 */
export type VectorBlockStorage =
  | { kind: 'shared-memory'; memory: WebAssembly.Memory }
  | { kind: 'private-memory'; simd: ArenaSimd }
  | { kind: 'bytes'; buffer: GrowableBuffer }

/**
 * This handle names one block of a field's vectors, which every thread
 * holding the field opens on its own side.
 *
 * @internal
 */
export interface VectorBlockHandle {
  /** The block follows this layout. */
  layout: VectorBlockLayout
  /** The block keeps its bytes here. */
  storage: VectorBlockStorage
}

function initialBlockBytes(layout: VectorBlockLayout): number {
  return layout.slotsOffset + VECTOR_BLOCK_INITIAL_SLOTS * layout.slotStride
}

function pagesFor(bytes: number): number {
  return Math.ceil(bytes / WASM_PAGE_BYTES)
}

function createSharedMemory(pages: number): WebAssembly.Memory | null {
  if (!sharedMemoryAvailable() || typeof WebAssembly === 'undefined') return null
  try {
    const memory = new WebAssembly.Memory({ initial: pages, maximum: MAX_WASM_PAGES, shared: true })
    return createSharedArenaSimd(memory) === null ? null : memory
  } catch {
    return null
  }
}

/**
 * Allocates one block, preferring a shared WebAssembly memory so that every
 * thread computes distances against one copy of the vectors.
 *
 * @param layout The layout the block follows.
 * @returns The block's handle.
 *
 * @internal
 */
export function createVectorBlock(layout: VectorBlockLayout): VectorBlockHandle {
  const initialBytes = initialBlockBytes(layout)
  const shared = createSharedMemory(pagesFor(initialBytes))
  if (shared !== null) return { layout, storage: { kind: 'shared-memory', memory: shared } }

  const simd = createArenaSimd()
  if (simd !== null) {
    const missing = pagesFor(initialBytes) - simd.memory.buffer.byteLength / WASM_PAGE_BYTES
    if (missing > 0) simd.memory.grow(missing)
    return { layout, storage: { kind: 'private-memory', simd } }
  }

  return { layout, storage: { kind: 'bytes', buffer: createGrowableBuffer(initialBytes, BLOCK_MAX_BYTES) } }
}

function growMemoryTo(memory: WebAssembly.Memory, bytes: number): void {
  const have = memory.buffer.byteLength
  if (have >= bytes) return
  memory.grow(pagesFor(nextGrowthTarget(have, bytes, BLOCK_MAX_BYTES)) - have / WASM_PAGE_BYTES)
}

/**
 * Grows a block so that it holds the given number of slots.
 *
 * @param handle The block to grow.
 * @param slots The slots it must hold afterwards.
 *
 * @internal
 */
export function ensureBlockSlots(handle: VectorBlockHandle, slots: number): void {
  const bytes = handle.layout.slotsOffset + Math.min(slots, handle.layout.capacity) * handle.layout.slotStride
  const storage = handle.storage
  if (storage.kind === 'bytes') {
    growBufferTo(storage.buffer, bytes)
    return
  }
  growMemoryTo(storage.kind === 'shared-memory' ? storage.memory : storage.simd.memory, bytes)
}

/**
 * Reports the bytes a block holds right now.
 *
 * @param handle The block to read.
 * @returns The buffer, which a later growth of a WebAssembly memory replaces.
 *
 * @internal
 */
export function blockBuffer(handle: VectorBlockHandle): GrowableBuffer {
  const storage = handle.storage
  if (storage.kind === 'bytes') return storage.buffer
  return storage.kind === 'shared-memory' ? storage.memory.buffer : storage.simd.memory.buffer
}

export const NOTHING_STAGED = -1
export const QUERY_STAGED = -2

/**
 * This is one thread's open handle on a block, holding the distance kernels
 * bound to the block's memory, the thread's own scratch offsets, and the
 * views that follow the memory as it grows.
 *
 * @internal
 */
export interface OpenVectorBlock {
  readonly handle: VectorBlockHandle
  readonly simd: ArenaSimd | null
  readonly hasScratch: boolean
  readonly float32ScratchByteOffset: number
  readonly codeScratchByteOffset: number
  /** This reads the ordinal whose vector the float32 scratch holds, or a marker for the query or for nothing. */
  stagedOrdinal: number
  /** This reads true while the code scratch holds the current query's codes. */
  codeQueryStaged: boolean
  /** Returns a float32 view over the block that reaches at least the given element. */
  float32(neededLength: number): Float32Array
  /** Returns a byte view over the block that reaches at least the given byte. */
  bytes(neededLength: number): Uint8Array
}

/**
 * Opens a block on the current thread.
 *
 * @param handle The block to open.
 * @param threadSlot This thread's scratch slot, which decides where the
 * thread writes a query so that concurrent searches stay apart.
 * @returns The open block.
 *
 * @internal
 */
export function openVectorBlock(handle: VectorBlockHandle, threadSlot: number): OpenVectorBlock {
  const { layout, storage } = handle
  const simd =
    storage.kind === 'shared-memory'
      ? createSharedArenaSimd(storage.memory)
      : storage.kind === 'private-memory'
        ? storage.simd
        : null
  const hasScratch = simd !== null && threadSlot >= 0 && threadSlot < VECTOR_SCRATCH_SLOTS
  const scratchSlot = hasScratch ? threadSlot : 0

  let float32View = fixedView(blockBuffer(handle), Float32Array)
  let byteView = fixedView(blockBuffer(handle), Uint8Array)

  return {
    handle,
    simd,
    hasScratch,
    float32ScratchByteOffset: scratchSlot * layout.float32ScratchStride,
    codeScratchByteOffset: layout.codeScratchOffset + scratchSlot * layout.codeScratchStride,
    stagedOrdinal: NOTHING_STAGED,
    codeQueryStaged: false,
    float32(neededLength: number): Float32Array {
      if (neededLength > float32View.length) float32View = fixedView(blockBuffer(handle), Float32Array)
      return float32View
    },
    bytes(neededLength: number): Uint8Array {
      if (neededLength > byteView.length) byteView = fixedView(blockBuffer(handle), Uint8Array)
      return byteView
    },
  }
}

/**
 * Reports the byte offset of a slot's vector inside its block.
 *
 * @param layout The layout the block follows.
 * @param localOrdinal The slot's ordinal inside its own block.
 * @returns The byte offset the vector starts at.
 *
 * @internal
 */
export function slotByteOffset(layout: VectorBlockLayout, localOrdinal: number): number {
  return layout.slotsOffset + localOrdinal * layout.slotStride
}
