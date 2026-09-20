import { loadNativeCore } from '#platform/native-core'
import { GRAPH_ENTRY_LOCK, GRAPH_SLOTS, type SharedGraphHandles } from '../hnsw/handles'
import type { HNSWSearchState } from '../hnsw/shared'
import { fixedView } from '../shared-buffers/growable'
import { nativeSearchCoreIsEnabled } from './backend'
import { isSharedMemory, type NativeStore, nativeStoreFor } from './store'
import type { NativeCore, NativeGraphHandle, NativeGraphMemory } from './types'

const WAKE_COUNT_WORDS = 1
const WAKES_THE_CORE_KEEPS_PER_CALL = 256
const WAKE_LIST_WORDS = WAKE_COUNT_WORDS + WAKES_THE_CORE_KEEPS_PER_CALL
const WAKE_ENTRY_LOCK = -1

export interface NativeField {
  core: NativeCore
  graph: NativeGraphHandle
  store: NativeStore
  wakes: Int32Array
}

interface AttachedGraph {
  handle: NativeGraphHandle | null
  field: NativeField | null
}

const attachedGraphs = new WeakMap<HNSWSearchState, AttachedGraph>()

function graphMemory(graph: SharedGraphHandles): NativeGraphMemory | null {
  const regions = [
    graph.header.buffer,
    graph.nodeLevels,
    graph.level0,
    graph.upperBase,
    graph.upper,
    graph.locks,
    graph.tombstones,
    graph.heldLocks.buffer,
  ]
  if (!regions.every(isSharedMemory)) return null
  return {
    graphHeader: graph.header,
    nodeLevels: fixedView(graph.nodeLevels, Uint8Array),
    level0: fixedView(graph.level0, Int32Array),
    upperBase: fixedView(graph.upperBase, Int32Array),
    upper: fixedView(graph.upper, Int32Array),
    locks: fixedView(graph.locks, Int32Array),
    tombstones: fixedView(graph.tombstones, Uint8Array),
    heldLocks: graph.heldLocks,
  }
}

function attach(core: NativeCore, state: HNSWSearchState): AttachedGraph {
  const memory = graphMemory(state.adjacency.handles)
  let handle: NativeGraphHandle | null = null
  if (memory !== null) {
    try {
      handle = core.attachGraph(memory)
    } catch {
      handle = null
    }
  }
  return { handle, field: null }
}

let workspaceOwner: WeakRef<HNSWSearchState> | null = null

export function nativeScratchBytes(state: HNSWSearchState, field: NativeField): number {
  const perField = field.store.ordinals.byteLength + field.store.distances.byteLength + field.wakes.byteLength
  const owner = workspaceOwner?.deref()
  if (owner !== undefined && owner !== state) return perField
  workspaceOwner = new WeakRef(state)
  return perField + field.core.workspaceBytes()
}

export function attachedNativeField(state: HNSWSearchState): NativeField | null {
  if (!nativeSearchCoreIsEnabled()) return null
  return attachedGraphs.get(state)?.field ?? null
}

export function nativeFieldFor(state: HNSWSearchState): NativeField | null {
  if (!nativeSearchCoreIsEnabled()) return null
  const core = loadNativeCore()
  if (core === null) return null
  const store = nativeStoreFor(state.store.handles)
  if (store === null) return null
  let attached = attachedGraphs.get(state)
  if (attached === undefined) {
    attached = attach(core, state)
    attachedGraphs.set(state, attached)
  }
  if (attached.handle === null) return null
  if (attached.field === null) {
    attached.field = { core, graph: attached.handle, store, wakes: new Int32Array(WAKE_LIST_WORDS) }
  }
  attached.field.store = store
  return attached.field
}

export function wakeSleepingThreads(state: HNSWSearchState, field: NativeField): void {
  const count = field.wakes[0]
  if (count === 0) return
  field.wakes[0] = 0
  for (let i = 1; i <= count; i++) {
    const ordinal = field.wakes[i]
    if (ordinal === WAKE_ENTRY_LOCK) {
      Atomics.notify(state.header, GRAPH_ENTRY_LOCK)
      continue
    }
    if (ordinal < 0 || ordinal >= Atomics.load(state.header, GRAPH_SLOTS)) continue
    Atomics.notify(state.locks.words(ordinal), ordinal)
  }
}
