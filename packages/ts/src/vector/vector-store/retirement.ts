import type { DocIdMap } from '../../core/doc-id-tables/types'
import { STORE_LIVE_COUNT } from './handles'
import { claimSlot, type OpenStore, publishOrdinal, writeVector } from './open-store'
import { mayFree, nextSequence, oldestHeldPin, publishSequence, retiredAtOf, stampBorn, stampRetired } from './pins'
import type { RetiredVectorPins } from './retired-pins'

export const UNKNOWN_PARTITION = -1
export const NO_PARTITION = -2
export const LOADED_SEQUENCE = 0
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

export function readable(state: StoreState, ordinal: number): boolean {
  return state.ordToDoc[ordinal] !== undefined || state.replacedOrdinals.has(ordinal) || state.awaitingFree.has(ordinal)
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
  stampBorn(store.sequences, ordinal, sequence)
  writeVector(store, ordinal, vector)
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

export function retireDocument(state: StoreState, docId: string): boolean {
  const store = state.open
  const ordinal = state.docToOrd.get(docId)
  if (store === null || ordinal === undefined || retiredAtOf(store.sequences, ordinal) !== 0) return false
  const sequence = beginWrite(state, store)
  retireInWrite(store, ordinal, sequence)
  endWrite(store, sequence)
  return true
}
