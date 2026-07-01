import { describe, expect, it } from 'vitest'
import {
  COMMIT_MARKER_FILE_SIZE,
  COMMIT_MARKER_SLOT_SIZE,
  type CommitMarkerState,
  encodeMarkerSlot,
  markerSlotOffset,
  nextMarkerSlot,
  readCommitMarker,
} from '../../../persistence/durability/commit-marker'

function state(writeSeq: number, durableByteLength: number, highestDurableSeqNo: number): CommitMarkerState {
  return { writeSeq, activeSegmentSeqNo: 1, durableByteLength, highestDurableSeqNo }
}

function writeMarker(slots: Array<{ slot: number; state: CommitMarkerState }>): Uint8Array {
  const file = new Uint8Array(COMMIT_MARKER_FILE_SIZE)
  for (const { slot, state: s } of slots) {
    file.set(encodeMarkerSlot(s), markerSlotOffset(slot))
  }
  return file
}

describe('commit marker', () => {
  it('selects the slot with the highest valid write_seq', () => {
    const marker = writeMarker([
      { slot: 0, state: state(1, 100, 5) },
      { slot: 1, state: state(2, 200, 9) },
    ])
    const result = readCommitMarker(marker)
    expect(result?.slotIndex).toBe(1)
    expect(result?.state.highestDurableSeqNo).toBe(9)
    expect(result?.state.durableByteLength).toBe(200)
  })

  it('falls back to the intact slot when the newer slot tears', () => {
    const marker = writeMarker([
      { slot: 0, state: state(1, 100, 5) },
      { slot: 1, state: state(2, 200, 9) },
    ])
    marker[markerSlotOffset(1) + 4] = marker[markerSlotOffset(1) + 4] ^ 0xff
    const result = readCommitMarker(marker)
    expect(result?.slotIndex).toBe(0)
    expect(result?.state.highestDurableSeqNo).toBe(5)
    expect(result?.state.durableByteLength).toBe(100)
  })

  it('returns null when neither slot is valid', () => {
    const marker = new Uint8Array(COMMIT_MARKER_FILE_SIZE)
    marker.fill(0x7f)
    expect(readCommitMarker(marker)).toBeNull()
  })

  it('returns null for an absent (empty) marker', () => {
    expect(readCommitMarker(new Uint8Array(0))).toBeNull()
  })

  it('alternates slots so a torn write never destroys the last good value', () => {
    expect(nextMarkerSlot(null)).toBe(0)
    expect(nextMarkerSlot(0)).toBe(1)
    expect(nextMarkerSlot(1)).toBe(0)
  })

  it('keeps each slot exactly 36 bytes and the file 72 bytes', () => {
    expect(COMMIT_MARKER_SLOT_SIZE).toBe(36)
    expect(COMMIT_MARKER_FILE_SIZE).toBe(72)
    expect(encodeMarkerSlot(state(1, 8, 1)).length).toBe(COMMIT_MARKER_SLOT_SIZE)
  })
})
