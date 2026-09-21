import {
  IDLE_HEAP_CLEANUP_MAX_GROWTH_BYTES,
  IDLE_HEAP_CLEANUP_MAX_UTILISATION,
  IDLE_HEAP_CLEANUP_MIN_RECLAIMABLE_BYTES,
  IDLE_HEAP_CLEANUP_QUIET_CHECKS,
} from './constants'

export interface ThreadHeap {
  heldBytes: number
  liveBytes: number
}

export interface IdleHeapCleanerDeps {
  utilisationSinceLastCheck(): number
  readHeap(): ThreadHeap | null
  collectAndReturnPages(): boolean
}

export interface IdleHeapCleaner {
  check(): boolean
}

export function createIdleHeapCleaner(deps: IdleHeapCleanerDeps): IdleHeapCleaner {
  let quietChecks = 0
  let liveBytesAfterLastCleanup = 0
  let heldBytesAtLastCheck = Number.POSITIVE_INFINITY

  return {
    check(): boolean {
      const busy = deps.utilisationSinceLastCheck() > IDLE_HEAP_CLEANUP_MAX_UTILISATION
      const before = deps.readHeap()
      if (before === null) return false
      const heapGrew = before.heldBytes > heldBytesAtLastCheck + IDLE_HEAP_CLEANUP_MAX_GROWTH_BYTES
      heldBytesAtLastCheck = before.heldBytes
      if (busy || heapGrew) {
        quietChecks = 0
        return false
      }
      quietChecks += 1
      if (quietChecks < IDLE_HEAP_CLEANUP_QUIET_CHECKS) return false
      if (before.heldBytes - liveBytesAfterLastCleanup < IDLE_HEAP_CLEANUP_MIN_RECLAIMABLE_BYTES) return false
      if (!deps.collectAndReturnPages()) return false

      const after = deps.readHeap()
      liveBytesAfterLastCleanup = after?.liveBytes ?? before.liveBytes
      heldBytesAtLastCheck = after?.heldBytes ?? before.heldBytes
      quietChecks = 0
      return true
    },
  }
}
