import type { HybridObject } from 'react-native-nitro-modules'

export interface MemoryView {
  buffer: ArrayBuffer
  byteOffset: number
  byteLength: number
}

export interface GraphMemory {
  graphHeader: MemoryView
  nodeLevels: MemoryView
  level0: MemoryView
  upperBase: MemoryView
  upper: MemoryView
  locks: MemoryView
  tombstones: MemoryView
  incoming: MemoryView
  nearestLinkDue: MemoryView
  heldLocks: MemoryView
}

export interface StoreMemory {
  storeHeader: MemoryView
  dimension: number
  bits: number
  recordsPerBlock: number
  vectorsPerBlock: number
  vectorStrideBytes: number
  codePresent: MemoryView
  centroid: MemoryView
  magnitudes: MemoryView
  present: MemoryView
  vectorFile: MemoryView
  vectorOffset: MemoryView
  vectorFiles: string[]
  codeBlocks: MemoryView[]
  vectorBlocks: MemoryView[]
}

export interface NativeSearchHits {
  count: number
  ordinals: ArrayBuffer
  distances: ArrayBuffer
}

export interface NativeScores {
  status: number
  distances: ArrayBuffer
}

export interface NativeConnectOutcome {
  status: number
  wakes: ArrayBuffer
}

export interface NarsilAttachedGraph extends HybridObject<{ ios: 'c++'; android: 'c++' }> {}

export interface NarsilAttachedStore extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  detach(): number
}

export interface NarsilCore extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  abiVersion(): number
  workspaceBytes(): number
  attachGraph(memory: GraphMemory): NarsilAttachedGraph
  attachStore(memory: StoreMemory): NarsilAttachedStore
  search(
    graph: NarsilAttachedGraph,
    store: NarsilAttachedStore,
    query: MemoryView,
    metric: number,
    candidateCount: number,
    threadSlot: number,
    ordinals: MemoryView,
    distances: MemoryView,
    accepted: MemoryView,
    filtered: boolean,
  ): number
  searchAsync(
    graph: NarsilAttachedGraph,
    store: NarsilAttachedStore,
    query: MemoryView,
    metric: number,
    candidateCount: number,
    threadSlot: number,
    accepted: MemoryView,
    filtered: boolean,
  ): Promise<NativeSearchHits>
  scoreAsync(
    store: NarsilAttachedStore,
    query: MemoryView,
    metric: number,
    ordinals: MemoryView,
    count: number,
    threadSlot: number,
  ): Promise<NativeScores>
  score(
    store: NarsilAttachedStore,
    query: MemoryView,
    metric: number,
    ordinals: MemoryView,
    count: number,
    distances: MemoryView,
  ): number
  place(
    graph: NarsilAttachedGraph,
    store: NarsilAttachedStore,
    metric: number,
    ordinal: number,
    topLayer: number,
    graphHeldAlone: number,
    threadSlot: number,
    wakes: MemoryView,
  ): number
  remove(graph: NarsilAttachedGraph, ordinal: number, threadSlot: number, wakes: MemoryView): number
  compact(
    graph: NarsilAttachedGraph,
    store: NarsilAttachedStore,
    metric: number,
    threadSlot: number,
    wakes: MemoryView,
  ): number
  connectUnreached(
    graph: NarsilAttachedGraph,
    store: NarsilAttachedStore,
    metric: number,
    nearby: MemoryView,
    threadSlot: number,
    wakes: MemoryView,
  ): number
  connectUnreachedAsync(
    graph: NarsilAttachedGraph,
    store: NarsilAttachedStore,
    metric: number,
    nearby: MemoryView,
    threadSlot: number,
  ): Promise<NativeConnectOutcome>
  measure(store: NarsilAttachedStore, metric: number, ordinals: MemoryView, count: number, totals: MemoryView): number
  quantise(store: NarsilAttachedStore, metric: number, ordinals: MemoryView, count: number): number
}
