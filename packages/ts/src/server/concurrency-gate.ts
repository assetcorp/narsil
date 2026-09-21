export interface RequestGate {
  tryAcquire(): boolean
  release(): void
}

export const MAIN_THREAD_GATE_SLOT = 0

export function gateSlotOfWorker(workerId: number): number {
  return workerId + 1
}

export function createSharedGateBuffer(slotCount: number): SharedArrayBuffer {
  return new SharedArrayBuffer(slotCount * Int32Array.BYTES_PER_ELEMENT)
}

export function clearGateSlot(buffer: SharedArrayBuffer, slot: number): void {
  const counters = new Int32Array(buffer)
  if (slot >= 0 && slot < counters.length) Atomics.store(counters, slot, 0)
}

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
