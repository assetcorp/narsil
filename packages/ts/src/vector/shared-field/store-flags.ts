import { UNPLACED_FLAG_CHUNK_ORDINALS } from '../constants'
import type { GrowableBuffer } from '../shared-buffers/growable'
import { STORE_LIVE_COUNT, STORE_REMOVED_COUNT, STORE_UNPLACED_COUNT } from '../vector-store/handles'
import type { SharedVectorStoreView } from '../vector-store/view'

export interface StoreFlags {
  liveDocuments(): number
  isRemoved(ordinal: number): boolean
  unplacedOrdinals(): number[]
}

interface FlagView<View> {
  source: GrowableBuffer | null
  view: View
}

function bytesOf(flags: FlagView<Uint8Array>, source: GrowableBuffer): Uint8Array {
  if (flags.source !== source) {
    flags.source = source
    flags.view = new Uint8Array(source)
  }
  return flags.view
}

function countsOf(chunks: FlagView<Int32Array>, source: GrowableBuffer): Int32Array {
  if (chunks.source !== source) {
    chunks.source = source
    chunks.view = new Int32Array(source)
  }
  return chunks.view
}

export function readStoreFlags(store: SharedVectorStoreView): StoreFlags {
  const unplaced: FlagView<Uint8Array> = { source: null, view: new Uint8Array(0) }
  const unplacedChunks: FlagView<Int32Array> = { source: null, view: new Int32Array(0) }
  const removed: FlagView<Uint8Array> = { source: null, view: new Uint8Array(0) }

  return {
    liveDocuments() {
      const header = store.handles.header
      return Atomics.load(header, STORE_LIVE_COUNT) - Atomics.load(header, STORE_REMOVED_COUNT)
    },

    isRemoved(ordinal) {
      const bytes = bytesOf(removed, store.handles.removed)
      return ordinal < bytes.length && Atomics.load(bytes, ordinal) === 1
    },

    unplacedOrdinals() {
      const handles = store.handles
      if (Atomics.load(handles.header, STORE_UNPLACED_COUNT) === 0) return []
      const bytes = bytesOf(unplaced, handles.unplaced)
      const counts = countsOf(unplacedChunks, handles.unplacedChunks)
      const end = Math.min(store.slots, bytes.length)
      const ordinals: number[] = []
      for (let chunk = 0; chunk < counts.length; chunk++) {
        const from = chunk * UNPLACED_FLAG_CHUNK_ORDINALS
        if (from >= end) break
        if (Atomics.load(counts, chunk) === 0) continue
        const to = Math.min(end, from + UNPLACED_FLAG_CHUNK_ORDINALS)
        for (let ordinal = from; ordinal < to; ordinal++) {
          if (Atomics.load(bytes, ordinal) === 1) ordinals.push(ordinal)
        }
      }
      return ordinals
    },
  }
}
