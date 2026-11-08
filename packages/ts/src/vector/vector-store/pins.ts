import { type SharedVectorStoreHandles, STORE_WRITE_SEQUENCE_INT64, writeSequenceWords } from './handles'

const TWO_TO_THE_32 = 4_294_967_296
const NO_PIN = 0n
const NOT_RETIRED = 0n

export interface SequenceWrites {
  readonly header: BigInt64Array
  readonly born: BigInt64Array
  readonly retired: BigInt64Array
}

export function sequenceWritesOf(handles: SharedVectorStoreHandles): SequenceWrites {
  return {
    header: writeSequenceWords(handles.header),
    born: new BigInt64Array(handles.bornAt),
    retired: new BigInt64Array(handles.retiredAt),
  }
}

export function writeSequenceOf(header: BigInt64Array): number {
  return Number(Atomics.load(header, STORE_WRITE_SEQUENCE_INT64))
}

export function nextSequence(writes: SequenceWrites): number {
  return writeSequenceOf(writes.header) + 1
}

export function stampBorn(writes: SequenceWrites, ordinal: number, sequence: number): void {
  Atomics.store(writes.born, ordinal, BigInt(sequence))
  if (Atomics.load(writes.retired, ordinal) !== NOT_RETIRED) Atomics.store(writes.retired, ordinal, NOT_RETIRED)
}

export function stampRetired(writes: SequenceWrites, ordinal: number, sequence: number): boolean {
  if (Atomics.load(writes.retired, ordinal) !== NOT_RETIRED) return false
  Atomics.store(writes.retired, ordinal, BigInt(sequence))
  return true
}

export function retiredAtOf(writes: SequenceWrites, ordinal: number): number {
  return Number(Atomics.load(writes.retired, ordinal))
}

export function publishSequence(writes: SequenceWrites, sequence: number): void {
  Atomics.store(writes.header, STORE_WRITE_SEQUENCE_INT64, BigInt(sequence))
}

export function oldestHeldPin(pins: BigInt64Array): number {
  let oldest = Number.POSITIVE_INFINITY
  for (let slot = 0; slot < pins.length; slot++) {
    const entry = Atomics.load(pins, slot)
    if (entry === NO_PIN) continue
    const pinned = Number(entry) - 1
    if (pinned < oldest) oldest = pinned
  }
  return oldest
}

export function releasePinsHeldBy(pins: BigInt64Array, threadSlot: number): void {
  if (threadSlot >= 0 && threadSlot < pins.length) Atomics.store(pins, threadSlot, NO_PIN)
}

export function mayFree(retiredAt: number, oldestPin: number): boolean {
  return retiredAt > 0 && retiredAt <= oldestPin
}

export interface SequenceReads {
  born: Uint32Array
  retired: Uint32Array
  retiredExact: BigInt64Array
}

export function admitsOrdinal(reads: SequenceReads, ordinal: number, pin: number): boolean {
  const low = ordinal * 2
  const bornHigh = reads.born[low + 1]
  const born = bornHigh === 0 ? reads.born[low] : bornHigh * TWO_TO_THE_32 + reads.born[low]
  if (born > pin) return false
  if (reads.retired[low] === 0 && reads.retired[low + 1] === 0) return true
  const retired = Number(Atomics.load(reads.retiredExact, ordinal))
  return retired === 0 || retired > pin
}

export interface ThreadPins {
  take(): number
  retain(sequence: number): void
  release(pin: number): void
  readonly held: number
}

export function createThreadPins(pinsOf: () => BigInt64Array, headerOf: () => BigInt64Array, slot: number): ThreadPins {
  const held: number[] = []

  function recordOldest(pins: BigInt64Array): void {
    if (held.length === 0) {
      Atomics.store(pins, slot, NO_PIN)
      return
    }
    let oldest = held[0]
    for (let i = 1; i < held.length; i++) if (held[i] < oldest) oldest = held[i]
    Atomics.store(pins, slot, BigInt(oldest + 1))
  }

  return {
    retain(sequence) {
      held.push(sequence)
      recordOldest(pinsOf())
    },
    take() {
      const pins = pinsOf()
      const header = headerOf()
      for (;;) {
        const seen = writeSequenceOf(header)
        if (Atomics.load(pins, slot) === NO_PIN) Atomics.store(pins, slot, BigInt(seen + 1))
        if (writeSequenceOf(header) !== seen) continue
        held.push(seen)
        recordOldest(pins)
        return seen
      }
    },
    release(pin) {
      const at = held.indexOf(pin)
      if (at === -1) return
      held.splice(at, 1)
      recordOldest(pinsOf())
    },
    get held() {
      return held.length
    },
  }
}
