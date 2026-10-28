export interface BodyBudgetRefusal {
  requestBytes: number
  inFlightBytes: number
  limitBytes: number
}

export interface BodyHold {
  readonly bytes: number
  grow(bytes: number): BodyBudgetRefusal | null
  releaseAll(): void
}

export interface BodyBudget {
  hold(): BodyHold
}

export function createBodyBudgetBuffer(slotCount: number): SharedArrayBuffer {
  return new SharedArrayBuffer(slotCount * BigInt64Array.BYTES_PER_ELEMENT)
}

export function clearBodyBudgetSlot(buffer: SharedArrayBuffer, slot: number): void {
  const counters = new BigInt64Array(buffer)
  if (slot >= 0 && slot < counters.length) Atomics.store(counters, slot, 0n)
}

export function createSharedBodyBudget(buffer: SharedArrayBuffer, limitBytes: number, slot: number): BodyBudget {
  const counters = new BigInt64Array(buffer)

  function inFlight(): number {
    let total = 0n
    for (let at = 0; at < counters.length; at++) total += Atomics.load(counters, at)
    return Number(total)
  }

  function take(bytes: number): void {
    Atomics.add(counters, slot, BigInt(bytes))
  }

  function give(bytes: number): void {
    if (Atomics.load(counters, slot) >= BigInt(bytes)) Atomics.sub(counters, slot, BigInt(bytes))
    else Atomics.store(counters, slot, 0n)
  }

  return {
    hold() {
      let held = 0
      return {
        get bytes() {
          return held
        },
        grow(bytes) {
          if (bytes <= 0) return null
          take(bytes)
          const total = inFlight()
          const others = total - held - bytes
          if (others > 0 && total > limitBytes) {
            give(bytes)
            return { requestBytes: held + bytes, inFlightBytes: others, limitBytes }
          }
          held += bytes
          return null
        },
        releaseAll() {
          if (held === 0) return
          give(held)
          held = 0
        },
      }
    },
  }
}
