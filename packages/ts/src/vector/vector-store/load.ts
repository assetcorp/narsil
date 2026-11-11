import {
  IN_MEMORY,
  magnitude,
  STORE_LIVE_COUNT,
  STORE_RELEASED_VECTORS_TO_DISK,
  STORE_SLOTS,
  stampBorn,
  stampRetired,
} from '#platform/vector-host'
import {
  claimSlot,
  ensureOrdinal,
  type OpenStore,
  placeOnDisk,
  publishOnDisk,
  publishOrdinal,
  writeVector,
} from './open-store'
import {
  appendOrdinal,
  claimOrdinal,
  LOADED_SEQUENCE,
  NO_PARTITION,
  RETIRED_BEFORE_LOAD,
  retireOrdinal,
  type StoreState,
} from './retirement'
import type { DiskLocation, VectorStoreSnapshot } from './types'

function retiredBeforeLoad(store: OpenStore, ordinal: number): void {
  stampRetired(store.sequences, ordinal, RETIRED_BEFORE_LOAD)
}

function settleLoadedReplacement(state: StoreState, store: OpenStore, previous: number | undefined): void {
  if (previous === undefined) {
    state.liveCount++
    Atomics.add(store.handles.header, STORE_LIVE_COUNT, 1)
    return
  }
  stampRetired(store.sequences, previous, RETIRED_BEFORE_LOAD)
  retireOrdinal(state, store, previous, Number.POSITIVE_INFINITY)
}

export function loadColdVector(
  state: StoreState,
  store: OpenStore,
  docId: string,
  vectorMagnitude: number,
  location: DiskLocation,
  partitionId?: number,
): number {
  const previous = state.docToOrd.get(docId)
  Atomics.store(store.handles.header, STORE_RELEASED_VECTORS_TO_DISK, 1)
  const ordinal = claimOrdinal(state, store, docId, true, partitionId)
  placeOnDisk(store, ordinal, vectorMagnitude, location)
  stampBorn(store.sequences, ordinal, LOADED_SEQUENCE)
  publishOrdinal(store, ordinal)
  settleLoadedReplacement(state, store, previous)
  return ordinal
}

export function loadReplacedVector(
  state: StoreState,
  store: OpenStore,
  docId: string,
  vector: Float32Array,
  location?: DiskLocation,
): number {
  if (location !== undefined) Atomics.store(store.handles.header, STORE_RELEASED_VECTORS_TO_DISK, 1)
  const ordinal = claimSlot(store, docId, location !== undefined)
  store.partitions[ordinal] = NO_PARTITION
  state.ordToDoc[ordinal] = undefined
  state.replacedOrdinals.add(ordinal)
  retiredBeforeLoad(store, ordinal)
  if (location !== undefined) {
    publishOnDisk(store, ordinal, magnitude(vector), location)
    return ordinal
  }
  writeVector(store, ordinal, vector)
  publishOrdinal(store, ordinal)
  return ordinal
}

function restoreReplacedVector(state: StoreState, store: OpenStore, ordinal: number, vector: Float32Array): void {
  store.diskFile[ordinal] = IN_MEMORY
  retiredBeforeLoad(store, ordinal)
  writeVector(store, ordinal, vector)
  Atomics.store(store.present, ordinal, 1)
  state.replacedOrdinals.add(ordinal)
}

export function loadSnapshot(state: StoreState, store: OpenStore, snapshot: VectorStoreSnapshot): void {
  const replaced = new Set(snapshot.replacedOrdinals)
  for (let ordinal = 0; ordinal < snapshot.slots; ordinal++) {
    const docId = snapshot.docIds[ordinal]
    const vector = snapshot.vectors.subarray(ordinal * snapshot.dimension, (ordinal + 1) * snapshot.dimension)
    if (docId === null || docId === undefined) {
      ensureOrdinal(store, ordinal, false)
      state.ordToDoc[ordinal] = undefined
      store.partitions[ordinal] = NO_PARTITION
      if (replaced.has(ordinal)) restoreReplacedVector(state, store, ordinal, vector)
      else retiredBeforeLoad(store, ordinal)
      Atomics.store(store.handles.header, STORE_SLOTS, ordinal + 1)
      continue
    }
    appendOrdinal(state, store, docId, vector, LOADED_SEQUENCE)
    state.liveCount++
  }
  Atomics.store(store.handles.header, STORE_LIVE_COUNT, state.liveCount)
}
