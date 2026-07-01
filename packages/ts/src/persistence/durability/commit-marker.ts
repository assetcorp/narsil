import { crc32 } from './checksum'

export const COMMIT_MARKER_SLOT_SIZE = 36
export const COMMIT_MARKER_SLOT_COUNT = 2
export const COMMIT_MARKER_FILE_SIZE = COMMIT_MARKER_SLOT_SIZE * COMMIT_MARKER_SLOT_COUNT
const CRC_OFFSET = 32

export interface CommitMarkerState {
  writeSeq: number
  activeSegmentSeqNo: number
  durableByteLength: number
  highestDurableSeqNo: number
}

export function encodeMarkerSlot(state: CommitMarkerState): Uint8Array {
  const slot = new Uint8Array(COMMIT_MARKER_SLOT_SIZE)
  const view = new DataView(slot.buffer)
  view.setBigUint64(0, BigInt(state.writeSeq), false)
  view.setBigUint64(8, BigInt(state.activeSegmentSeqNo), false)
  view.setBigUint64(16, BigInt(state.durableByteLength), false)
  view.setBigUint64(24, BigInt(state.highestDurableSeqNo), false)
  view.setUint32(CRC_OFFSET, crc32(slot.subarray(0, CRC_OFFSET)), false)
  return slot
}

function decodeSlot(data: Uint8Array, slotIndex: number): CommitMarkerState | null {
  const base = slotIndex * COMMIT_MARKER_SLOT_SIZE
  if (base + COMMIT_MARKER_SLOT_SIZE > data.length) {
    return null
  }
  const slot = data.subarray(base, base + COMMIT_MARKER_SLOT_SIZE)
  const view = new DataView(slot.buffer, slot.byteOffset, slot.byteLength)
  const storedCrc = view.getUint32(CRC_OFFSET, false)
  if (crc32(slot.subarray(0, CRC_OFFSET)) !== storedCrc) {
    return null
  }
  const writeSeq = view.getBigUint64(0, false)
  const activeSegmentSeqNo = view.getBigUint64(8, false)
  const durableByteLength = view.getBigUint64(16, false)
  const highestDurableSeqNo = view.getBigUint64(24, false)
  if (
    writeSeq > BigInt(Number.MAX_SAFE_INTEGER) ||
    activeSegmentSeqNo > BigInt(Number.MAX_SAFE_INTEGER) ||
    durableByteLength > BigInt(Number.MAX_SAFE_INTEGER) ||
    highestDurableSeqNo > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null
  }
  return {
    writeSeq: Number(writeSeq),
    activeSegmentSeqNo: Number(activeSegmentSeqNo),
    durableByteLength: Number(durableByteLength),
    highestDurableSeqNo: Number(highestDurableSeqNo),
  }
}

export function readCommitMarker(data: Uint8Array): { state: CommitMarkerState; slotIndex: number } | null {
  let best: { state: CommitMarkerState; slotIndex: number } | null = null
  for (let slotIndex = 0; slotIndex < COMMIT_MARKER_SLOT_COUNT; slotIndex += 1) {
    const state = decodeSlot(data, slotIndex)
    if (state === null) {
      continue
    }
    if (best === null || state.writeSeq > best.state.writeSeq) {
      best = { state, slotIndex }
    }
  }
  return best
}

export function nextMarkerSlot(lastWrittenSlot: number | null): number {
  if (lastWrittenSlot === null) {
    return 0
  }
  return (lastWrittenSlot + 1) % COMMIT_MARKER_SLOT_COUNT
}

export function markerSlotOffset(slotIndex: number): number {
  return slotIndex * COMMIT_MARKER_SLOT_SIZE
}
