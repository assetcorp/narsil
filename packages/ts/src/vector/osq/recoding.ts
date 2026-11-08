import type { VectorMetric } from '../brute-force'
import { slotByteOffset } from '../vector-store/blocks'
import type { VectorCodeBlockLayout } from '../vector-store/code-blocks'
import type { SharedVectorStoreView } from '../vector-store/view'
import { createOsqScratch, osqQuantize } from './quantize'
import { writeRecord } from './record'

export interface CodeRecoding {
  readonly centroid: Float32Array
  recode(ordinal: number): void
  copyIntoStore(slots: number): void
}

export interface RecodingSource {
  readonly store: SharedVectorStoreView
  readonly layout: VectorCodeBlockLayout
  readonly metric: VectorMetric
  holds(ordinal: number): boolean
  clearCodes(ordinal: number): void
}

interface RecodedBlock {
  bytes: Uint8Array
  data: DataView
  usedBytes: number
}

export function createCodeRecoding(source: RecodingSource, centroid: Float32Array): CodeRecoding {
  const { store, layout, metric } = source
  const { capacity, slotStride, bits } = layout
  const scratch = createOsqScratch(layout.dimension)
  const blocks: Array<RecodedBlock | undefined> = []
  let recoded = new Uint8Array(0)

  function blockReaching(blockIndex: number, end: number): RecodedBlock {
    const held = blocks[blockIndex]
    if (held !== undefined && held.bytes.length >= end) return held
    const length = Math.min(capacity * slotStride, Math.max(end, (held?.bytes.length ?? 0) * 2))
    const bytes = new Uint8Array(length)
    if (held !== undefined) bytes.set(held.bytes)
    const block = { bytes, data: new DataView(bytes.buffer), usedBytes: held?.usedBytes ?? 0 }
    blocks[blockIndex] = block
    return block
  }

  function markRecoded(ordinal: number): void {
    if (ordinal >= recoded.length) {
      const grown = new Uint8Array(Math.max(ordinal + 1, recoded.length * 2))
      grown.set(recoded)
      recoded = grown
    }
    recoded[ordinal] = 1
  }

  function recode(ordinal: number): void {
    if (!source.holds(ordinal) || !store.holdsOrdinal(ordinal)) return
    const offset = (ordinal % capacity) * slotStride
    const block = blockReaching(Math.floor(ordinal / capacity), offset + slotStride)
    const code = osqQuantize(store.vectorAt(ordinal), centroid, bits, metric, scratch)
    writeRecord(block.bytes, offset, code, bits, block.data)
    block.usedBytes = Math.max(block.usedBytes, offset + slotStride)
    markRecoded(ordinal)
  }

  function copyIntoStore(slots: number): void {
    for (let ordinal = 0; ordinal < slots; ordinal++) {
      if (!source.holds(ordinal) || (ordinal < recoded.length && recoded[ordinal] === 1)) continue
      recode(ordinal)
      if (ordinal >= recoded.length || recoded[ordinal] !== 1) source.clearCodes(ordinal)
    }
    const start = slotByteOffset(layout, 0)
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex]
      if (block === undefined || block.usedBytes === 0) continue
      const target = store.codeBlockOf(blockIndex * capacity).bytes(start + block.usedBytes)
      target.set(block.bytes.subarray(0, block.usedBytes), start)
    }
  }

  return { centroid, recode, copyIntoStore }
}
