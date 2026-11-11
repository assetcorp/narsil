import { requireBytesWithinLimit, VECTOR_MEMORY_LIMITS } from '#platform/vector-host'
import { requireOrdinalWithinLimit } from '../vector-store/open-store'
import type { ColdFieldClaims, ColdVectorHold, HeldReplacement, HeldVector } from './cold'

const encoder = new TextEncoder()

const queuedWriteUndone = (): void => undefined

export function sameVector(held: Float32Array, vector: Float32Array): boolean {
  for (let at = 0; at < vector.length; at++) if (held[at] !== vector[at]) return false
  return true
}

function claimsOfField(hold: ColdVectorHold, wanted: ColdFieldClaims): ColdFieldClaims {
  const atMost = hold.field.claimsAtMost
  const fits =
    atMost.slots + wanted.slots <= VECTOR_MEMORY_LIMITS.maxOrdinals &&
    atMost.docIdBytes + wanted.docIdBytes <= VECTOR_MEMORY_LIMITS.maxDocIdTableBytes
  return fits ? atMost : hold.field.claims()
}

export function requireRoomInHold(hold: ColdVectorHold, docId: string): ColdFieldClaims {
  const { reserved } = hold
  const wanted = { slots: reserved.slots + 1, docIdBytes: reserved.docIdBytes + encoder.encode(docId).length }
  const loaded = claimsOfField(hold, wanted)
  requireOrdinalWithinLimit(loaded.slots + reserved.slots)
  requireBytesWithinLimit(loaded.docIdBytes + wanted.docIdBytes, VECTOR_MEMORY_LIMITS.maxDocIdTableBytes)
  return wanted
}

function reserveReplayedInsert(hold: ColdVectorHold, docId: string): ColdFieldClaims {
  const wanted = requireRoomInHold(hold, docId)
  const added = { slots: wanted.slots - hold.reserved.slots, docIdBytes: wanted.docIdBytes - hold.reserved.docIdBytes }
  hold.reserved.slots = wanted.slots
  hold.reserved.docIdBytes = wanted.docIdBytes
  return added
}

function retireCopy(hold: ColdVectorHold, docId: string): HeldVector | number | undefined {
  const written = hold.written.get(docId)
  if (written !== undefined) {
    hold.written.delete(docId)
    return written
  }
  if (hold.removedIds.has(docId)) return undefined
  const number = hold.field.numberOf(docId)
  if (number === undefined) return undefined
  hold.removedIds.add(docId)
  hold.removedNumbers.add(number)
  return number
}

function vectorOfCopy(hold: ColdVectorHold, copy: HeldVector | number): Float32Array {
  return typeof copy === 'number' ? hold.field.reusedVectorOfNumber(copy) : copy.vector
}

function putBackCopy(hold: ColdVectorHold, docId: string, copy: HeldVector | number): void {
  if (typeof copy === 'number') {
    hold.removedIds.delete(docId)
    hold.removedNumbers.delete(copy)
  } else {
    hold.written.set(docId, copy)
  }
}

function restoreRemovedCopy(hold: ColdVectorHold, docId: string, vector: Float32Array): boolean {
  const removal = hold.removals.get(docId)
  if (removal === undefined) return false
  const { copy, queuedAt } = removal
  if (!sameVector(vectorOfCopy(hold, copy), vector)) return false
  hold.removals.delete(docId)
  hold.writes[queuedAt] = queuedWriteUndone
  putBackCopy(hold, docId, copy)
  hold.live += 1
  return true
}

function keepReplacement(hold: ColdVectorHold, docId: string, replacement: HeldReplacement): void {
  const kept = hold.replacements.get(docId)
  if (kept === undefined) hold.replacements.set(docId, [replacement])
  else kept.push(replacement)
}

function fieldHoldsVector(hold: ColdVectorHold, docId: string, vector: Float32Array): boolean {
  if (hold.removedIds.has(docId)) return false
  const number = hold.field.numberOf(docId)
  return number !== undefined && sameVector(hold.field.reusedVectorOfNumber(number), vector)
}

export function coldInsert(
  hold: ColdVectorHold,
  docId: string,
  vector: Float32Array,
  partitionId: number | undefined,
  keepsReplacedCopy: boolean,
  replay: () => void,
): boolean {
  const restored = !hold.written.has(docId) && restoreRemovedCopy(hold, docId, vector)
  const written = hold.written.get(docId)
  if (written !== undefined && sameVector(written.vector, vector)) {
    if (partitionId === undefined || partitionId === written.partitionId) return restored
    hold.written.set(docId, { vector: written.vector, partitionId })
    hold.writes.push(replay)
    return true
  }
  if (written === undefined && (restored || fieldHoldsVector(hold, docId, vector))) {
    if (partitionId === undefined) return restored
    hold.writes.push(replay)
    return true
  }
  const reserved = reserveReplayedInsert(hold, docId)
  const removal = hold.removals.get(docId)
  hold.removals.delete(docId)
  const retired = retireCopy(hold, docId)
  if (retired === undefined) hold.live += 1
  const inserted: HeldVector = { vector, partitionId }
  hold.written.set(docId, inserted)
  const copy = removal === undefined ? retired : removal.copy
  if (keepsReplacedCopy && copy !== undefined) {
    const queuedAt = removal === undefined ? [hold.writes.length] : [removal.queuedAt, hold.writes.length]
    keepReplacement(hold, docId, { copy, inserted, queuedAt, reserved })
  }
  hold.writes.push(replay)
  return true
}

export function coldRemove(hold: ColdVectorHold, docId: string, replay: () => void): boolean {
  const copy = retireCopy(hold, docId)
  if (copy === undefined) return false
  hold.live -= 1
  hold.removals.set(docId, { queuedAt: hold.writes.length, copy })
  hold.writes.push(replay)
  return true
}

export function coldRestore(hold: ColdVectorHold, docId: string, vector: Float32Array): boolean {
  if (!hold.written.has(docId)) return restoreRemovedCopy(hold, docId, vector)
  const replacements = hold.replacements.get(docId)
  const last = replacements?.[replacements.length - 1]
  if (replacements === undefined || last === undefined || hold.written.get(docId) !== last.inserted) return false
  if (!sameVector(vectorOfCopy(hold, last.copy), vector)) return false
  replacements.pop()
  if (replacements.length === 0) hold.replacements.delete(docId)
  for (const at of last.queuedAt) hold.writes[at] = queuedWriteUndone
  hold.written.delete(docId)
  putBackCopy(hold, docId, last.copy)
  hold.reserved.slots -= last.reserved.slots
  hold.reserved.docIdBytes -= last.reserved.docIdBytes
  return true
}
