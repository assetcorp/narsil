export interface RequestGate {
  tryAcquire(): boolean
  release(): void
}

/**
 * The slot the main thread counts its own requests in; each request thread
 * counts in the slot after its worker id.
 *
 * @internal
 */
export const MAIN_THREAD_GATE_SLOT = 0

export function gateSlotOfWorker(workerId: number): number {
  return workerId + 1
}

export function createSharedGateBuffer(slotCount: number): SharedArrayBuffer {
  return new SharedArrayBuffer(slotCount * Int32Array.BYTES_PER_ELEMENT)
}

/**
 * Forgets every request a dead thread counted, so its share of the cap comes
 * back to the threads still serving.
 *
 * @internal
 */
export function clearGateSlot(buffer: SharedArrayBuffer, slot: number): void {
  const counters = new Int32Array(buffer)
  if (slot >= 0 && slot < counters.length) Atomics.store(counters, slot, 0)
}

/**
 * A request cap shared across the main thread and every request thread: each
 * thread counts its own requests in flight in its own slot, and an admission
 * sums every slot, so a thread that dies takes only its own count with it.
 *
 * @param buffer The shared memory every thread's gate reads.
 * @param max The requests the server admits at once, or every request where zero.
 * @param slot The slot this thread counts in.
 * @returns The gate this thread admits requests through.
 *
 * @internal
 */
export function createSharedRequestGate(buffer: SharedArrayBuffer, max: number, slot: number): RequestGate {
  const counters = new Int32Array(buffer)

  function inFlight(): number {
    let total = 0
    for (let at = 0; at < counters.length; at++) total += Atomics.load(counters, at)
    return total
  }

  return {
    tryAcquire(): boolean {
      if (max <= 0) return true
      if (inFlight() >= max) return false
      Atomics.add(counters, slot, 1)
      if (inFlight() <= max) return true
      Atomics.sub(counters, slot, 1)
      return false
    },
    release(): void {
      if (max <= 0) return
      if (Atomics.load(counters, slot) > 0) Atomics.sub(counters, slot, 1)
    },
  }
}
