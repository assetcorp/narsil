import { loadNativeCore } from '#platform/native-core'
import type { VectorMetric } from '../brute-force'
import { NATIVE_ATTACH_RETRY_MS } from '../constants'
import { fixedView, type GrowableBuffer } from '../shared-buffers/growable'
import type { VectorBlockHandle } from '../vector-store/blocks'
import { type SharedVectorStoreHandles, STORE_CALIBRATED } from '../vector-store/handles'
import { nativeSearchCoreIsEnabled, stopUsingTheNativeSearchCore } from './backend'
import { NATIVE_NEEDS_ROOM, NATIVE_OK, type NativeCore, type NativeStoreHandle, type NativeStoreMemory } from './types'

const METRIC_CODES: Readonly<Record<VectorMetric, number>> = { cosine: 0, dotProduct: 1, euclidean: 2 }

interface AttachedStore {
  core: NativeCore
  handle: NativeStoreHandle | null
  layoutRevision: number
  vectorBlockCount: number
  codeBlockCount: number
  retryAt: number
  ordinals: Int32Array
  distances: Float64Array
}

export interface NativeStore extends AttachedStore {
  handle: NativeStoreHandle
}

const attachedStores = new WeakMap<SharedVectorStoreHandles, AttachedStore>()

export function nativeMetricCode(metric: VectorMetric): number {
  return METRIC_CODES[metric]
}

export function isSharedMemory(buffer: GrowableBuffer | ArrayBufferLike): boolean {
  return typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer
}

function blockBytes(block: VectorBlockHandle): Uint8Array | null {
  const storage = block.storage
  if (storage.kind === 'shared-memory') return new Uint8Array(storage.memory.buffer, block.layout.slotsOffset)
  if (storage.kind === 'bytes' && isSharedMemory(storage.buffer)) {
    return new Uint8Array(storage.buffer, block.layout.slotsOffset)
  }
  return null
}

function storeMemory(store: SharedVectorStoreHandles): NativeStoreMemory | null {
  const regions = [
    store.header.buffer,
    store.codePresent,
    store.centroid.buffer,
    store.magnitudes,
    store.present,
    store.diskFile,
    store.diskOffset,
  ]
  if (!regions.every(isSharedMemory)) return null

  const codeBlocks: Uint8Array[] = []
  for (const block of store.codeBlocks) {
    const bytes = blockBytes(block)
    if (bytes === null) return null
    codeBlocks.push(bytes)
  }
  const vectorBlocks: Array<Uint8Array | null> = []
  for (const block of store.blocks) {
    const bytes = block === null ? null : blockBytes(block)
    if (block !== null && bytes === null) return null
    vectorBlocks.push(bytes)
  }

  return {
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
    vectorFile: fixedView(store.diskFile, Int32Array),
    vectorOffset: fixedView(store.diskOffset, Uint32Array),
    vectorFiles: [...store.vectorFiles],
    codeBlocks,
    vectorBlocks,
  }
}

function attach(core: NativeCore, store: SharedVectorStoreHandles): AttachedStore {
  const memory = storeMemory(store)
  let handle: NativeStoreHandle | null = null
  if (memory !== null) {
    try {
      handle = core.attachStore(memory)
    } catch {
      handle = null
    }
  }
  return {
    core,
    handle,
    layoutRevision: store.layoutRevision,
    vectorBlockCount: store.blocks.length,
    codeBlockCount: store.codeBlocks.length,
    retryAt: handle === null ? Date.now() + NATIVE_ATTACH_RETRY_MS : Number.POSITIVE_INFINITY,
    ordinals: new Int32Array(0),
    distances: new Float64Array(0),
  }
}

function stillCurrent(attached: AttachedStore, store: SharedVectorStoreHandles): boolean {
  return (
    Date.now() < attached.retryAt &&
    attached.layoutRevision === store.layoutRevision &&
    attached.vectorBlockCount === store.blocks.length &&
    attached.codeBlockCount === store.codeBlocks.length
  )
}

function isUsable(attached: AttachedStore): attached is NativeStore {
  return attached.handle !== null
}

export function detachNativeStore(store: SharedVectorStoreHandles): void {
  const attached = attachedStores.get(store)
  if (attached === undefined) return
  attachedStores.delete(store)
  if (attached.handle === null) return
  try {
    attached.core.detachStore(attached.handle)
  } catch (error) {
    stopUsingTheNativeSearchCore(error)
  }
}

export function attachedNativeStore(store: SharedVectorStoreHandles): NativeStore | null {
  const attached = attachedStores.get(store)
  return attached !== undefined && isUsable(attached) ? attached : null
}

export function nativeStoreScratchBytes(store: SharedVectorStoreHandles): number {
  const attached = attachedNativeStore(store)
  return attached === null ? 0 : attached.ordinals.byteLength + attached.distances.byteLength
}

export function nativeStoreFor(store: SharedVectorStoreHandles): NativeStore | null {
  if (!nativeSearchCoreIsEnabled()) return null
  const core = loadNativeCore()
  if (core === null) return null
  let attached = attachedStores.get(store)
  if (attached !== undefined && !stillCurrent(attached, store)) {
    detachNativeStore(store)
    attached = undefined
  }
  if (attached === undefined) {
    attached = attach(core, store)
    attachedStores.set(store, attached)
  }
  return isUsable(attached) ? attached : null
}

export function reserveOrdinals(store: NativeStore, count: number): void {
  if (store.ordinals.length >= count) return
  store.ordinals = new Int32Array(count)
  store.distances = new Float64Array(count)
}

export function nativeScores(
  store: NativeStore,
  query: Float32Array,
  metric: VectorMetric,
  count: number,
): Float64Array | null {
  if (count === 0) return store.distances
  let status: number
  try {
    status = store.core.score(store.handle, query, nativeMetricCode(metric), store.ordinals, count, store.distances)
  } catch (error) {
    stopUsingTheNativeSearchCore(error)
    return null
  }
  return status === NATIVE_OK ? store.distances : null
}

export function nativeScoresOf(
  handles: SharedVectorStoreHandles,
  query: Float32Array,
  metric: VectorMetric,
  ordinals: ArrayLike<number>,
): Float64Array | null {
  const store = nativeStoreFor(handles)
  if (store === null) return null
  reserveOrdinals(store, ordinals.length)
  store.ordinals.set(ordinals)
  return nativeScores(store, query, metric, ordinals.length)
}

function workOnRecords(
  handles: SharedVectorStoreHandles,
  metric: VectorMetric,
  ordinals: Int32Array,
  work: 'calibrate' | 'quantise',
): boolean {
  if (ordinals.length === 0) return true
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = nativeStoreFor(handles)
    if (store === null) return false
    let status: number
    try {
      status = store.core[work](store.handle, nativeMetricCode(metric), ordinals, ordinals.length)
    } catch (error) {
      stopUsingTheNativeSearchCore(error)
      return false
    }
    if (status === NATIVE_OK) return true
    if (status !== NATIVE_NEEDS_ROOM) return false
    detachNativeStore(handles)
  }
  return false
}

export function nativeCalibrate(
  handles: SharedVectorStoreHandles,
  metric: VectorMetric,
  ordinals: Int32Array,
): boolean {
  return workOnRecords(handles, metric, ordinals, 'calibrate')
}

export function nativeQuantise(handles: SharedVectorStoreHandles, metric: VectorMetric, ordinals: Int32Array): boolean {
  if (Atomics.load(handles.header, STORE_CALIBRATED) !== 1) return false
  return workOnRecords(handles, metric, ordinals, 'quantise')
}
