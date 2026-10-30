import { INITIAL_WRITE_RECORD_SLOTS } from './constants'

export interface WriteRecord {
  seqNo: number
  primaryTerm: number
}

export interface WriteRecordTable {
  readonly count: number
  set(documentId: string, seqNo: number, primaryTerm: number): void
  remove(documentId: string): void
  recordOf(documentId: string): WriteRecord | null
  seqNoOf(documentId: string): number
  primaryTermOf(documentId: string): number
  clear(): void
}

export function createWriteRecordTable(): WriteRecordTable {
  const slots = new Map<string, number>()
  let seqNos = new Float64Array(0)
  let primaryTerms = new Float64Array(0)
  let freeSlots: number[] = []
  let nextSlot = 0

  function grow(): void {
    const capacity = Math.max(INITIAL_WRITE_RECORD_SLOTS, seqNos.length * 2)
    const grownSeqNos = new Float64Array(capacity)
    const grownTerms = new Float64Array(capacity)
    grownSeqNos.set(seqNos)
    grownTerms.set(primaryTerms)
    seqNos = grownSeqNos
    primaryTerms = grownTerms
  }

  function claimSlot(): number {
    const reused = freeSlots.pop()
    if (reused !== undefined) return reused
    if (nextSlot === seqNos.length) grow()
    return nextSlot++
  }

  return {
    get count() {
      return slots.size
    },

    set(documentId, seqNo, primaryTerm) {
      let slot = slots.get(documentId)
      if (slot === undefined) {
        slot = claimSlot()
        slots.set(documentId, slot)
      }
      seqNos[slot] = seqNo
      primaryTerms[slot] = primaryTerm
    },

    remove(documentId) {
      const slot = slots.get(documentId)
      if (slot === undefined) return
      slots.delete(documentId)
      seqNos[slot] = 0
      primaryTerms[slot] = 0
      freeSlots.push(slot)
    },

    recordOf(documentId) {
      const slot = slots.get(documentId)
      if (slot === undefined) return null
      return { seqNo: seqNos[slot], primaryTerm: primaryTerms[slot] }
    },

    seqNoOf(documentId) {
      const slot = slots.get(documentId)
      return slot === undefined ? 0 : seqNos[slot]
    },

    primaryTermOf(documentId) {
      const slot = slots.get(documentId)
      return slot === undefined ? 0 : primaryTerms[slot]
    },

    clear() {
      slots.clear()
      seqNos = new Float64Array(0)
      primaryTerms = new Float64Array(0)
      freeSlots = []
      nextSlot = 0
    },
  }
}
