import { ErrorCodes, NarsilError } from '../../errors'
import { MAX_VECTOR_ORDINALS } from '../constants'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter } from '../ordinal-filter'
import type { OsqBits } from '../osq/quantize'
import { growBufferTo } from '../shared-buffers/growable'
import { magnitude } from '../similarity'
import { createVectorBlock, ensureBlockSlots, slotByteOffset } from './blocks'
import {
  createSharedVectorStoreHandles,
  IN_MEMORY,
  type SharedVectorStoreHandles,
  STORE_BLOCK_COUNT,
  STORE_CODE_BLOCK_COUNT,
  STORE_SLOTS,
} from './handles'
import type { DiskLocation } from './types'
import { openSharedVectorStore, type SharedVectorStoreView } from './view'

export interface OpenStore {
  handles: SharedVectorStoreHandles
  view: SharedVectorStoreView
  magnitudes: Float64Array
  present: Uint8Array
  partitions: Int32Array
  diskFile: Int32Array
  diskOffset: Uint32Array
}

export type OrdinalDocuments = ReadonlyArray<string | undefined>

export function openHandles(dimension: number, codeBits: OsqBits | null, blockBytes: number): OpenStore {
  const handles = createSharedVectorStoreHandles(dimension, codeBits, blockBytes)
  return {
    handles,
    view: openSharedVectorStore(handles, 0),
    magnitudes: new Float64Array(handles.magnitudes),
    present: new Uint8Array(handles.present),
    partitions: new Int32Array(handles.partitions),
    diskFile: new Int32Array(handles.diskFile),
    diskOffset: new Uint32Array(handles.diskOffset),
  }
}

export function relayout(store: OpenStore): void {
  store.handles.layoutRevision += 1
  store.view.adoptHandles(store.handles)
}

function ensureCodeSlot(store: OpenStore, ordinal: number): void {
  const { handles } = store
  if (handles.codeLayout === null) return
  const blockIndex = Math.floor(ordinal / handles.codeLayout.capacity)
  while (handles.codeBlocks.length <= blockIndex) {
    handles.codeBlocks.push(createVectorBlock(handles.codeLayout))
    Atomics.store(handles.header, STORE_CODE_BLOCK_COUNT, handles.codeBlocks.length)
    relayout(store)
  }
  ensureBlockSlots(handles.codeBlocks[blockIndex], (ordinal % handles.codeLayout.capacity) + 1)
}

function ensureFloatSlot(store: OpenStore, ordinal: number): void {
  const { handles } = store
  const blockIndex = Math.floor(ordinal / handles.layout.capacity)
  let changed = false
  while (handles.blocks.length <= blockIndex) {
    handles.blocks.push(null)
    changed = true
  }
  if (handles.blocks[blockIndex] === null) {
    handles.blocks[blockIndex] = createVectorBlock(handles.layout)
    changed = true
  }
  if (changed) {
    Atomics.store(handles.header, STORE_BLOCK_COUNT, handles.blocks.length)
    relayout(store)
  }
  const block = handles.blocks[blockIndex]
  if (block !== null) ensureBlockSlots(block, (ordinal % handles.layout.capacity) + 1)
}

export function ensureOrdinal(store: OpenStore, ordinal: number, cold: boolean): void {
  if (ordinal >= MAX_VECTOR_ORDINALS) {
    throw new NarsilError(
      ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      `A vector field holds at most ${MAX_VECTOR_ORDINALS} vectors, deleted ones included, until it is rebuilt`,
      { ordinal, maxOrdinals: MAX_VECTOR_ORDINALS },
    )
  }
  const { handles } = store
  growBufferTo(handles.magnitudes, (ordinal + 1) * 8)
  growBufferTo(handles.present, ordinal + 1)
  growBufferTo(handles.partitions, (ordinal + 1) * 4)
  growBufferTo(handles.codePresent, ordinal + 1)
  const diskFileBytes = handles.diskFile.byteLength
  growBufferTo(handles.diskFile, (ordinal + 1) * 4)
  if (handles.diskFile.byteLength > diskFileBytes) {
    new Int32Array(handles.diskFile).fill(IN_MEMORY, diskFileBytes / 4)
  }
  growBufferTo(handles.diskOffset, (ordinal + 1) * 4)
  if (!cold) ensureFloatSlot(store, ordinal)
  ensureCodeSlot(store, ordinal)
}

export function writeVector(store: OpenStore, ordinal: number, vector: Float32Array): void {
  const block = store.view.blockOf(ordinal)
  const base = slotByteOffset(store.handles.layout, store.view.localOrdinal(ordinal)) / 4
  block.float32(base + vector.length).set(vector, base)
  store.magnitudes[ordinal] = magnitude(vector)
}

export function blockFullyCold(store: OpenStore, blockIndex: number, documents: OrdinalDocuments): boolean {
  const capacity = store.handles.layout.capacity
  const slots = Atomics.load(store.handles.header, STORE_SLOTS)
  const end = Math.min(slots, (blockIndex + 1) * capacity)
  if (end < (blockIndex + 1) * capacity) return false
  for (let ordinal = blockIndex * capacity; ordinal < end; ordinal++) {
    if (documents[ordinal] !== undefined && store.diskFile[ordinal] === IN_MEMORY) return false
  }
  return true
}

export function fileHoldsSameBytes(store: OpenStore, ordinal: number, location: DiskLocation): boolean {
  const fromFile = new Float32Array(store.handles.dimension)
  if (!store.view.readFromFile(location.fileIndex, location.offset, fromFile)) return false
  const held = store.view.vectorAt(ordinal)
  const a = new Uint8Array(fromFile.buffer)
  const b = new Uint8Array(held.buffer, held.byteOffset, held.byteLength)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function forgetUnreferencedFiles(store: OpenStore, documents: OrdinalDocuments): void {
  const referenced = new Set<number>()
  for (let ordinal = 0; ordinal < documents.length; ordinal++) {
    if (documents[ordinal] !== undefined && store.diskFile[ordinal] !== IN_MEMORY) {
      referenced.add(store.diskFile[ordinal])
    }
  }
  for (let file = 0; file < store.handles.vectorFiles.length; file++) {
    if (!referenced.has(file)) store.handles.vectorFiles[file] = ''
  }
}

export function partitionFilterOf(
  store: OpenStore | null,
  documents: OrdinalDocuments,
  partitionIds: ReadonlySet<number>,
): OrdinalFilter {
  const filter = createOrdinalFilter(documents.length)
  if (store === null) return filter
  let highest = -1
  for (const partitionId of partitionIds) {
    if (partitionId > highest) highest = partitionId
  }
  if (highest < 0) return filter
  const wanted = new Uint8Array(highest + 1)
  for (const partitionId of partitionIds) {
    if (partitionId >= 0) wanted[partitionId] = 1
  }
  for (let ordinal = 0; ordinal < documents.length; ordinal++) {
    if (documents[ordinal] === undefined) continue
    const partitionId = store.partitions[ordinal]
    if (partitionId < 0 || partitionId > highest || wanted[partitionId] === 0) continue
    addToOrdinalFilter(filter, ordinal)
  }
  return filter
}
