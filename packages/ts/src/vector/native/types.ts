export interface NativeGraphMemory {
  graphHeader: Int32Array
  nodeLevels: Uint8Array
  level0: Int32Array
  upperBase: Int32Array
  upper: Int32Array
  locks: Int32Array
  tombstones: Uint8Array
  heldLocks: Int32Array
}

export interface NativeStoreMemory {
  storeHeader: Int32Array
  dimension: number
  bits: number
  recordsPerBlock: number
  vectorsPerBlock: number
  vectorStrideBytes: number
  codePresent: Uint8Array
  centroid: Float32Array
  magnitudes: Float64Array
  present: Uint8Array
  vectorFile: Int32Array
  vectorOffset: Uint32Array
  vectorFiles: string[]
  codeBlocks: Uint8Array[]
  vectorBlocks: Array<Uint8Array | null>
}

export type NativeGraphHandle = object
export type NativeStoreHandle = object

export const NATIVE_OK = 0
export const NATIVE_NEEDS_ROOM = 3

export interface NativeCore {
  abiVersion(): number
  workspaceBytes(): number
  attachGraph(memory: NativeGraphMemory): NativeGraphHandle
  attachStore(memory: NativeStoreMemory): NativeStoreHandle
  detachStore(store: NativeStoreHandle): number
  search(
    graph: NativeGraphHandle,
    store: NativeStoreHandle,
    query: Float32Array,
    metric: number,
    candidateCount: number,
    threadSlot: number,
    ordinals: Int32Array,
    distances: Float64Array,
  ): number
  score(
    store: NativeStoreHandle,
    query: Float32Array,
    metric: number,
    ordinals: Int32Array,
    count: number,
    distances: Float64Array,
  ): number
  place(
    graph: NativeGraphHandle,
    store: NativeStoreHandle,
    metric: number,
    ordinal: number,
    topLayer: number,
    graphHeldAlone: number,
    threadSlot: number,
    wakes: Int32Array,
  ): number
  remove(graph: NativeGraphHandle, ordinal: number, threadSlot: number, wakes: Int32Array): number
  compact(
    graph: NativeGraphHandle,
    store: NativeStoreHandle,
    metric: number,
    threadSlot: number,
    wakes: Int32Array,
  ): number
  calibrate(store: NativeStoreHandle, metric: number, ordinals: Int32Array, count: number): number
  quantise(store: NativeStoreHandle, metric: number, ordinals: Int32Array, count: number): number
}
