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
export const BLOCK_MAX_BYTES = MAX_WASM_PAGES * WASM_PAGE_BYTES

export function alignUp(bytes: number): number {
  return Math.ceil(bytes / SCRATCH_ALIGNMENT_BYTES) * SCRATCH_ALIGNMENT_BYTES
}

/**
 * This geometry gives the byte offset of every region inside one block. A
 * block begins with one query scratch for each thread slot, and the slots
 * follow them, each holding one record of a fixed stride.
 *
 * @internal
 */
export interface BlockGeometry {
  /** Each thread's query scratch spans this many bytes. */
  scratchStride: number
  /** The slots start at this byte offset. */
  slotsOffset: number
  /** Each slot spans this many bytes. */
  slotStride: number
  /** The block holds this many slots at most. */
  capacity: number
}

/**
 * This is the geometry of a block holding float32 vectors, one per slot.
 *
 * @internal
 */
export interface VectorBlockLayout extends BlockGeometry {
  /** Every vector of the field has this many components. */
  dimension: number
}

export function computeVectorBlockLayout(dimension: number, blockBytes: number = BLOCK_MAX_BYTES): VectorBlockLayout {
  const scratchStride = alignUp(dimension * 4)
  const slotsOffset = alignUp(VECTOR_SCRATCH_SLOTS * scratchStride)
  const slotStride = alignUp(dimension * 4)
  return {
    dimension,
    scratchStride,
    slotsOffset,
    slotStride,
    capacity: Math.max(1, Math.floor((Math.min(blockBytes, BLOCK_MAX_BYTES) - slotsOffset) / slotStride)),
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
 * This handle names one block of a field, which every thread holding the
 * field opens on its own side.
 *
 * @internal
 */
export interface VectorBlockHandle<Layout extends BlockGeometry = BlockGeometry> {
  /** The block follows this layout. */
  layout: Layout
  /** The block keeps its bytes here. */
  storage: VectorBlockStorage
}

function initialBlockBytes(layout: BlockGeometry): number {
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

export function createVectorBlock<Layout extends BlockGeometry>(layout: Layout): VectorBlockHandle<Layout> {
  const initialBytes = initialBlockBytes(layout)
  const shared = createSharedMemory(pagesFor(initialBytes))
  if (shared !== null) return { layout, storage: { kind: 'shared-memory', memory: shared } }

  const simd = createArenaSimd()
  if (simd !== null) {
    const missing = pagesFor(initialBytes) - simd.memory.buffer.byteLength / WASM_PAGE_BYTES
    if (missing > 0) simd.memory.grow(missing)
    return { layout, storage: { kind: 'private-memory', simd } }
  }

  return { layout, storage: { kind: 'bytes', buffer: createGrowableBuffer(initialBytes, fullBlockBytes(layout)) } }
}

function fullBlockBytes(layout: BlockGeometry): number {
  return Math.min(BLOCK_MAX_BYTES, layout.slotsOffset + layout.capacity * layout.slotStride)
}

function growMemoryTo(memory: WebAssembly.Memory, bytes: number, layout: BlockGeometry): void {
  const have = memory.buffer.byteLength
  if (have >= bytes) return
  memory.grow(pagesFor(nextGrowthTarget(have, bytes, fullBlockBytes(layout))) - have / WASM_PAGE_BYTES)
}

export function ensureBlockSlots(handle: VectorBlockHandle, slots: number): void {
  const bytes = handle.layout.slotsOffset + Math.min(slots, handle.layout.capacity) * handle.layout.slotStride
  const storage = handle.storage
  if (storage.kind === 'bytes') {
    growBufferTo(storage.buffer, bytes)
    return
  }
  growMemoryTo(storage.kind === 'shared-memory' ? storage.memory : storage.simd.memory, bytes, handle.layout)
}

export function blockBuffer(handle: VectorBlockHandle): GrowableBuffer {
  const storage = handle.storage
  if (storage.kind === 'bytes') return storage.buffer
  return storage.kind === 'shared-memory' ? storage.memory.buffer : storage.simd.memory.buffer
}

export const NOTHING_STAGED = -1
export const QUERY_STAGED = -2

export interface OpenVectorBlock {
  readonly handle: VectorBlockHandle
  readonly simd: ArenaSimd | null
  readonly hasScratch: boolean
  readonly scratchByteOffset: number
  /** This reads the ordinal whose record the scratch holds, or a marker for the query or for nothing. */
  stagedOrdinal: number
  /** Returns a float32 view over the block that reaches at least the given element. */
  float32(neededLength: number): Float32Array
  /** Returns a byte view over the block that reaches at least the given byte. */
  bytes(neededLength: number): Uint8Array
  /** Returns a data view over the block that reaches at least the given byte. */
  data(neededLength: number): DataView
}

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
  let dataView = new DataView(blockBuffer(handle))

  return {
    handle,
    simd,
    hasScratch,
    scratchByteOffset: scratchSlot * layout.scratchStride,
    stagedOrdinal: NOTHING_STAGED,
    float32(neededLength: number): Float32Array {
      if (neededLength > float32View.length) float32View = fixedView(blockBuffer(handle), Float32Array)
      return float32View
    },
    bytes(neededLength: number): Uint8Array {
      if (neededLength > byteView.length) byteView = fixedView(blockBuffer(handle), Uint8Array)
      return byteView
    },
    data(neededLength: number): DataView {
      if (neededLength > dataView.byteLength) dataView = new DataView(blockBuffer(handle))
      return dataView
    },
  }
}

export function slotByteOffset(layout: BlockGeometry, localOrdinal: number): number {
  return layout.slotsOffset + localOrdinal * layout.slotStride
}
