import { fixedView, type GrowableBuffer } from '../shared-buffers/growable'
import { type SharedVectorStoreHandles, STORE_WRITE_SEQUENCE_INT64, writeSequenceWords } from './handles'

const TWO_TO_THE_32 = 4_294_967_296
const NO_PIN = 0n
const NOT_RETIRED = 0n
const UNSTAMPED = 0n

export interface SequenceWrites {
  readonly header: BigInt64Array
  readonly headerHalves: Uint32Array
  readonly bornBuffer: GrowableBuffer
  readonly retiredBuffer: GrowableBuffer
  born: BigInt64Array
  retired: BigInt64Array
  retiredHalves: Uint32Array
}

export function sequenceWritesOf(handles: SharedVectorStoreHandles): SequenceWrites {
  const header = handles.header
  return {
    header: writeSequenceWords(header),
    headerHalves: new Uint32Array(header.buffer, header.byteOffset, header.length),
    bornBuffer: handles.bornAt,
    retiredBuffer: handles.retiredAt,
    born: fixedView(handles.bornAt, BigInt64Array),
    retired: fixedView(handles.retiredAt, BigInt64Array),
    retiredHalves: fixedView(handles.retiredAt, Uint32Array),
  }
}

export function coverOrdinal(writes: SequenceWrites, ordinal: number): void {
  if (ordinal < writes.born.length && ordinal < writes.retired.length) return
  writes.born = fixedView(writes.bornBuffer, BigInt64Array)
  writes.retired = fixedView(writes.retiredBuffer, BigInt64Array)
  writes.retiredHalves = fixedView(writes.retiredBuffer, Uint32Array)
}

function writtenSequence(halves: Uint32Array, at: number): number {
  const high = halves[at * 2 + 1]
  return high === 0 ? halves[at * 2] : high * TWO_TO_THE_32 + halves[at * 2]
}

export function writeSequenceOf(header: BigInt64Array): number {
  return Number(Atomics.load(header, STORE_WRITE_SEQUENCE_INT64))
}

export function publishedSequence(writes: SequenceWrites): number {
  return writtenSequence(writes.headerHalves, STORE_WRITE_SEQUENCE_INT64)
}

export function nextSequence(writes: SequenceWrites): number {
  return publishedSequence(writes) + 1
}

export function stampBorn(writes: SequenceWrites, ordinal: number, sequence: number): void {
  coverOrdinal(writes, ordinal)
  Atomics.store(writes.born, ordinal, BigInt(sequence))
  if (writtenSequence(writes.retiredHalves, ordinal) !== 0) Atomics.store(writes.retired, ordinal, NOT_RETIRED)
}

export function stampRetired(writes: SequenceWrites, ordinal: number, sequence: number): boolean {
  coverOrdinal(writes, ordinal)
  if (writtenSequence(writes.retiredHalves, ordinal) !== 0) return false
  Atomics.store(writes.retired, ordinal, BigInt(sequence))
  return true
}

export function retiredAtOf(writes: SequenceWrites, ordinal: number): number {
  coverOrdinal(writes, ordinal)
  return writtenSequence(writes.retiredHalves, ordinal)
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
  born: BigInt64Array
  retired: BigInt64Array
}

export function admitsOrdinal(reads: SequenceReads, ordinal: number, pin: bigint): boolean {
  const retired = Atomics.load(reads.retired, ordinal)
  if (retired !== NOT_RETIRED && retired <= pin) return false
  const born = Atomics.load(reads.born, ordinal)
  return born !== UNSTAMPED && born <= pin
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
