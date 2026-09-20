import { loadNativeCore } from '#platform/native-core'
import type { VectorMetric } from '../brute-force'
import type { SharedGraphHandles } from '../hnsw/handles'
import type { HNSWSearchState } from '../hnsw/shared'
import { fixedView, type GrowableBuffer } from '../shared-buffers/growable'
import type { VectorBlockHandle } from '../vector-store/blocks'
import {
  type SharedVectorStoreHandles,
  STORE_CALIBRATED,
  STORE_CODE_COUNT,
  STORE_RELEASED_VECTORS_TO_DISK,
} from '../vector-store/handles'
import type { NativeCore, NativeFieldHandle, NativeFieldMemory } from './types'

const METRIC_CODES: Readonly<Record<VectorMetric, number>> = { cosine: 0, dotProduct: 1, euclidean: 2 }

interface AttachedField {
  core: NativeCore
  handle: NativeFieldHandle | null
  store: SharedVectorStoreHandles
  layoutRevision: number
  vectorBlockCount: number
  codeBlockCount: number
  ordinals: Int32Array
  distances: Float64Array
  layerCounts: Int32Array
  holdsEveryVector: boolean
}

export interface NativeField extends AttachedField {
  handle: NativeFieldHandle
}

const attachedFields = new WeakMap<HNSWSearchState, AttachedField>()

function isUsable(field: AttachedField): field is NativeField {
  return field.handle !== null
}

export function nativeMetricCode(metric: VectorMetric): number {
  return METRIC_CODES[metric]
}

function isShared(buffer: GrowableBuffer | ArrayBufferLike): boolean {
  return typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer
}

function blockBytes(block: VectorBlockHandle): Uint8Array | null {
  const storage = block.storage
  if (storage.kind === 'shared-memory') return new Uint8Array(storage.memory.buffer, block.layout.slotsOffset)
  if (storage.kind === 'bytes' && isShared(storage.buffer))
    return new Uint8Array(storage.buffer, block.layout.slotsOffset)
  return null
}

function everyVectorInMemory(store: SharedVectorStoreHandles): boolean {
  return Atomics.load(store.header, STORE_RELEASED_VECTORS_TO_DISK) === 0 && store.blocks.every(block => block !== null)
}

function fieldMemory(
  graph: SharedGraphHandles,
  store: SharedVectorStoreHandles,
  holdsEveryVector: boolean,
): NativeFieldMemory | null {
  const regions = [
    graph.header.buffer,
    graph.nodeLevels,
    graph.level0,
    graph.upperBase,
    graph.upper,
    graph.locks,
    graph.tombstones,
    graph.heldLocks.buffer,
    store.header.buffer,
    store.codePresent,
    store.centroid.buffer,
    store.magnitudes,
    store.present,
  ]
  if (!regions.every(isShared)) return null

  const codeBlocks: Uint8Array[] = []
  for (const block of store.codeBlocks) {
    const bytes = blockBytes(block)
    if (bytes === null) return null
    codeBlocks.push(bytes)
  }
  const vectorBlocks: Array<Uint8Array | null> = []
  for (const block of store.blocks) {
    if (block === null || !holdsEveryVector) {
      vectorBlocks.push(null)
      continue
    }
    const bytes = blockBytes(block)
    if (bytes === null) return null
    vectorBlocks.push(bytes)
  }

  return {
    graphHeader: graph.header,
    nodeLevels: fixedView(graph.nodeLevels, Uint8Array),
    level0: fixedView(graph.level0, Int32Array),
    upperBase: fixedView(graph.upperBase, Int32Array),
    upper: fixedView(graph.upper, Int32Array),
    locks: fixedView(graph.locks, Int32Array),
    tombstones: fixedView(graph.tombstones, Uint8Array),
    heldLocks: graph.heldLocks,
    storeHeader: store.header,
    dimension: store.dimension,
    bits: store.codeBits ?? 0,
    recordsPerBlock: store.codeLayout?.capacity ?? 0,
    vectorsPerBlock: store.layout.capacity,
    vectorStrideBytes: store.layout.slotStride,
    codePresent: fixedView(store.codePresent, Uint8Array),
    centroid: store.centroid,
    magnitudes: fixedView(store.magnitudes, Float64Array),
    present: fixedView(store.present, Uint8Array),
    codeBlocks,
    vectorBlocks,
  }
}

function attachedHandle(core: NativeCore, memory: NativeFieldMemory | null): NativeFieldHandle | null {
  if (memory === null) return null
  try {
    return core.attach(memory)
  } catch {
    return null
  }
}

function attach(core: NativeCore, state: HNSWSearchState, store: SharedVectorStoreHandles): AttachedField {
  const holdsEveryVector = everyVectorInMemory(store)
  return {
    core,
    handle: attachedHandle(core, fieldMemory(state.adjacency.handles, store, holdsEveryVector)),
    store,
    layoutRevision: store.layoutRevision,
    vectorBlockCount: store.blocks.length,
    codeBlockCount: store.codeBlocks.length,
    ordinals: new Int32Array(0),
    distances: new Float64Array(0),
    layerCounts: new Int32Array(0),
    holdsEveryVector,
  }
}

export function nativeServesWalk(field: NativeField): boolean {
  const header = field.store.header
  const walksCodes =
    field.store.codeBits !== null &&
    Atomics.load(header, STORE_CALIBRATED) === 1 &&
    Atomics.load(header, STORE_CODE_COUNT) > 0
  return walksCodes || field.holdsEveryVector
}

function stillCurrent(field: AttachedField, store: SharedVectorStoreHandles): boolean {
  return (
    field.store === store &&
    field.layoutRevision === store.layoutRevision &&
    field.vectorBlockCount === store.blocks.length &&
    field.codeBlockCount === store.codeBlocks.length &&
    field.holdsEveryVector === everyVectorInMemory(store)
  )
}

let nativeSearchCoreEnabled = true

export function setNativeSearchCoreEnabled(enabled: boolean): void {
  nativeSearchCoreEnabled = enabled
}

export function stopUsingTheNativeSearchCore(error: unknown): void {
  if (!nativeSearchCoreEnabled) return
  nativeSearchCoreEnabled = false
  console.warn(
    'The native search core raised an error, so this thread searches through WebAssembly from now on:',
    error instanceof Error ? error.message : String(error),
  )
}

let workspaceOwner: WeakRef<HNSWSearchState> | null = null

export function nativeScratchBytes(state: HNSWSearchState, field: NativeField): number {
  const perField = field.ordinals.byteLength + field.distances.byteLength + field.layerCounts.byteLength
  const owner = workspaceOwner?.deref()
  if (owner !== undefined && owner !== state) return perField
  workspaceOwner = new WeakRef(state)
  return perField + field.core.workspaceBytes()
}

export function nativeFieldFor(state: HNSWSearchState): NativeField | null {
  if (!nativeSearchCoreEnabled) return null
  const core = loadNativeCore()
  if (core === null) return null
  const store = state.store.handles
  let attached = attachedFields.get(state)
  if (attached === undefined || !stillCurrent(attached, store)) {
    attached = attach(core, state, store)
    attachedFields.set(state, attached)
  }
  return isUsable(attached) ? attached : null
}

export function reserveCandidates(field: NativeField, count: number): void {
  if (field.ordinals.length >= count) return
  field.ordinals = new Int32Array(count)
  field.distances = new Float64Array(count)
}
