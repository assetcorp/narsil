import {
  IN_MEMORY,
  nextSequence,
  oldestHeldPin,
  publishSequence,
  resetStoreHeader,
  STORE_CALIBRATED,
  STORE_CALIBRATION_GENERATION,
  STORE_CODE_COUNT,
  STORE_LIVE_COUNT,
  STORE_SLOTS,
  stampRetired,
} from '#platform/vector-host'
import { resetDocIds } from './doc-ids'
import { type OpenStore, relayout } from './open-store'

function retireEveryOrdinal(store: OpenStore): void {
  const sequences = store.sequences
  const sequence = nextSequence(sequences)
  const slots = Atomics.load(store.handles.header, STORE_SLOTS)
  for (let ordinal = 0; ordinal < slots; ordinal++) stampRetired(sequences, ordinal, sequence)
  publishSequence(sequences, sequence)
}

function forgetCodes(store: OpenStore): void {
  const { header, codePresent } = store.handles
  new Uint8Array(codePresent, 0, codePresent.byteLength).fill(0)
  Atomics.store(header, STORE_LIVE_COUNT, 0)
  Atomics.store(header, STORE_CODE_COUNT, 0)
  Atomics.store(header, STORE_CALIBRATED, 0)
  Atomics.add(header, STORE_CALIBRATION_GENERATION, 1)
}

function resetInPlace(store: OpenStore): void {
  const { handles } = store
  store.present.fill(0, 0, handles.present.byteLength)
  new Uint8Array(handles.codePresent, 0, handles.codePresent.byteLength).fill(0)
  new Int32Array(handles.diskFile, 0, handles.diskFile.byteLength / 4).fill(IN_MEMORY)
  handles.centroid.fill(0)
  if (handles.vectorFiles.length > 0) {
    handles.vectorFiles.length = 0
    relayout(store)
  }
  resetDocIds(handles)
  resetStoreHeader(handles.header)
}

export function clearStore(store: OpenStore): void {
  retireEveryOrdinal(store)
  if (oldestHeldPin(store.handles.pins) === Number.POSITIVE_INFINITY) {
    resetInPlace(store)
    return
  }
  forgetCodes(store)
}
