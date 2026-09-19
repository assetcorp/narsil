export interface NativeFieldMemory {
  graphHeader: Int32Array
  nodeLevels: Uint8Array
  level0: Int32Array
  upperBase: Int32Array
  upper: Int32Array
  locks: Int32Array
  tombstones: Uint8Array
  heldLocks: Int32Array
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
  codeBlocks: Uint8Array[]
  vectorBlocks: Array<Uint8Array | null>
}

export type NativeFieldHandle = object

export interface NativeCore {
  abiVersion(): number
  workspaceBytes(): number
  attach(memory: NativeFieldMemory): NativeFieldHandle
  search(
    field: NativeFieldHandle,
    query: Float32Array,
    metric: number,
    candidateCount: number,
    threadSlot: number,
    ordinals: Int32Array,
    distances: Float64Array,
  ): number
  place(
    field: NativeFieldHandle,
    vector: Float32Array,
    metric: number,
    ownOrdinal: number,
    topLayer: number,
    threadSlot: number,
    ordinals: Int32Array,
    distances: Float64Array,
    counts: Int32Array,
  ): number
  rescore(
    field: NativeFieldHandle,
    query: Float32Array,
    metric: number,
    ordinals: Int32Array,
    count: number,
    distances: Float64Array,
  ): number
}
