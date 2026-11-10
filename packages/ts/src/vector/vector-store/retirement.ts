import {
  coverOrdinal,
  mayFree,
  nextSequence,
  oldestHeldPin,
  publishSequence,
  retiredAtOf,
  STORE_LIVE_COUNT,
  stampBorn,
  stampRetired,
} from '#platform/vector-host'
import type { DocIdMap } from '../../core/doc-id-tables/types'
import { claimSlot, type OpenStore, publishOrdinal, writeVector } from './open-store'
import type { RetiredVectorPins } from './retired-pins'

export const UNKNOWN_PARTITION = -1
export const NO_PARTITION = -2
export const LOADED_SEQUENCE = 1
export const RETIRED_BEFORE_LOAD = 1

export interface StoreState {
  open: OpenStore | null
  readonly docToOrd: DocIdMap<number>
  readonly ordToDoc: Array<string | undefined>
  readonly replacedOrdinals: Set<number>
  readonly awaitingFree: Set<number>
  readonly checkpointPins: RetiredVectorPins
  unknownPartitions: number
  liveCount: number
}

export function oldestPinOf(store: OpenStore): number {
  return oldestHeldPin(store.handles.pins)
}

export function freeable(store: OpenStore, ordinal: number, oldestPin: number): boolean {
  return mayFree(retiredAtOf(store.sequences, ordinal), oldestPin)
}

export function recordPartition(
  state: StoreState,
  store: OpenStore,
  ordinal: number,
  partitionId: number | undefined,
): void {
  const given = partitionId !== undefined && partitionId >= 0 ? partitionId : UNKNOWN_PARTITION
  store.partitions[ordinal] = given
  if (given === UNKNOWN_PARTITION) state.unknownPartitions += 1
}

export function freeRetired(state: StoreState, store: OpenStore, ordinal: number): void {
  state.awaitingFree.delete(ordinal)
  Atomics.store(store.present, ordinal, 0)
  state.checkpointPins.note(ordinal)
}

export function retireOrdinal(state: StoreState, store: OpenStore, ordinal: number, oldestPin: number): void {
  state.ordToDoc[ordinal] = undefined
  if (store.partitions[ordinal] === UNKNOWN_PARTITION) state.unknownPartitions -= 1
  if (freeable(store, ordinal, oldestPin)) {
    freeRetired(state, store, ordinal)
    return
  }
  state.awaitingFree.add(ordinal)
}

export function keepReplacedOrdinal(state: StoreState, store: OpenStore, ordinal: number): void {
  state.ordToDoc[ordinal] = undefined
  if (store.partitions[ordinal] === UNKNOWN_PARTITION) state.unknownPartitions -= 1
  state.replacedOrdinals.add(ordinal)
}

export function freeAwaitingOrdinals(state: StoreState): void {
  const store = state.open
  if (store === null || state.awaitingFree.size === 0) return
  const oldestPin = oldestPinOf(store)
  for (const ordinal of state.awaitingFree) {
    if (freeable(store, ordinal, oldestPin)) freeRetired(state, store, ordinal)
  }
}

export function claimOrdinal(
  state: StoreState,
  store: OpenStore,
  docId: string,
  cold: boolean,
  partitionId?: number,
): number {
  const ordinal = claimSlot(store, docId, cold)
  recordPartition(state, store, ordinal, partitionId)
  state.ordToDoc[ordinal] = docId
  state.docToOrd.set(docId, ordinal)
  return ordinal
}

export function appendOrdinal(
  state: StoreState,
  store: OpenStore,
  docId: string,
  vector: Float32Array,
  sequence: number,
  partitionId?: number,
): number {
  const ordinal = claimOrdinal(state, store, docId, false, partitionId)
  writeVector(store, ordinal, vector)
  stampBorn(store.sequences, ordinal, sequence)
  publishOrdinal(store, ordinal)
  return ordinal
}

export function settleReplacement(
  state: StoreState,
  store: OpenStore,
  previous: number | undefined,
  keepsReplacedVector: boolean,
): void {
  if (previous === undefined) {
    state.liveCount++
    Atomics.add(store.handles.header, STORE_LIVE_COUNT, 1)
    return
  }
  if (keepsReplacedVector) keepReplacedOrdinal(state, store, previous)
  else retireOrdinal(state, store, previous, oldestPinOf(store))
}

export function beginWrite(state: StoreState, store: OpenStore): number {
  freeAwaitingOrdinals(state)
  return nextSequence(store.sequences)
}

export function retireInWrite(store: OpenStore, ordinal: number, sequence: number): void {
  stampRetired(store.sequences, ordinal, sequence)
}

export function endWrite(store: OpenStore, sequence: number): void {
  publishSequence(store.sequences, sequence)
}

export function retireStoredOrdinal(state: StoreState, ordinal: number): boolean {
  const store = state.open
  if (store === null) return false
  if (state.awaitingFree.size > 0) freeAwaitingOrdinals(state)
  const writes = store.sequences
  if (ordinal >= writes.retired.length) coverOrdinal(writes, ordinal)
  const retiredHalves = writes.retiredHalves
  const retiredLow = ordinal * 2
  if (retiredHalves[retiredLow] !== 0 || retiredHalves[retiredLow + 1] !== 0) return false
  const sequence = nextSequence(writes)
  Atomics.store(writes.retired, ordinal, BigInt(sequence))
  publishSequence(writes, sequence)
  return true
}
