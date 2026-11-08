import { ErrorCodes, NarsilError } from '../../errors'
import { POOL_GROWTH_FACTOR, SLICE_GROWTH_FACTOR } from './constants'

export const NO_SLICE = 255
export const EMPTY_POSITIONS = 0
const MAX_POOL_ENTRIES = 2 ** 32 - 1
const NO_FREE_SLICE = 0xffffffff
const ALLOCATION_END = 0
const ALLOCATION_FREE = 1
const ALLOCATION_WORDS = 2

export const SLICE_CAPACITIES = ((): Uint32Array => {
  const capacities: number[] = [1]
  while (capacities[capacities.length - 1] < MAX_POOL_ENTRIES) {
    const previous = capacities[capacities.length - 1]
    capacities.push(Math.min(MAX_POOL_ENTRIES, Math.max(previous + 1, Math.ceil(previous * SLICE_GROWTH_FACTOR))))
  }
  return Uint32Array.from(capacities)
})()

export function sliceClassFor(entries: number): number {
  let low = 0
  let high = SLICE_CAPACITIES.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (SLICE_CAPACITIES[middle] < entries) low = middle + 1
    else high = middle
  }
  return low
}

export function sliceCapacity(sliceClass: number): number {
  return sliceClass === NO_SLICE ? 0 : SLICE_CAPACITIES[sliceClass]
}

export function grownCapacity(current: number, needed: number): number {
  requirePoolSize(needed)
  return Math.min(MAX_POOL_ENTRIES, Math.max(needed, Math.ceil(current * POOL_GROWTH_FACTOR)))
}

function requirePoolSize(size: number): void {
  if (!Number.isInteger(size) || size < 0 || size > MAX_POOL_ENTRIES)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The posting pool exceeds its uint32 address space')
}

export class PostingPool {
  docIds: Uint32Array
  frequencies: Uint16Array
  fieldIndices: Uint16Array
  positionStarts: Uint32Array | null = null
  readonly allocation = new Uint32Array(ALLOCATION_WORDS)
  readonly freeHeads = new Uint32Array(SLICE_CAPACITIES.length).fill(NO_FREE_SLICE)
  epoch = 0

  constructor(capacity: number) {
    requirePoolSize(capacity)
    this.docIds = new Uint32Array(capacity)
    this.frequencies = new Uint16Array(capacity)
    this.fieldIndices = new Uint16Array(capacity)
  }

  get end(): number {
    return this.allocation[ALLOCATION_END]
  }

  set end(value: number) {
    this.allocation[ALLOCATION_END] = value
  }

  get freeEntries(): number {
    return this.allocation[ALLOCATION_FREE]
  }

  prepareWrite(needed: number): void {
    this.reserve(needed)
  }

  allocate(sliceClass: number): number {
    const size = sliceCapacity(sliceClass)
    const reused = this.freeHeads[sliceClass]
    if (reused !== NO_FREE_SLICE) {
      this.freeHeads[sliceClass] = this.docIds[reused]
      this.allocation[ALLOCATION_FREE] -= size
      return reused
    }
    const start = this.end
    this.reserve(start + size)
    this.end = start + size
    return start
  }

  release(start: number, sliceClass: number): void {
    if (sliceClass === NO_SLICE) return
    this.docIds[start] = this.freeHeads[sliceClass]
    this.freeHeads[sliceClass] = start
    this.allocation[ALLOCATION_FREE] += sliceCapacity(sliceClass)
  }

  trackPositions(): Uint32Array {
    if (this.positionStarts === null) {
      this.positionStarts = new Uint32Array(this.docIds.length)
      this.epoch++
    }
    return this.positionStarts
  }

  move(from: number, to: number, count: number): void {
    this.docIds.copyWithin(to, from, from + count)
    this.frequencies.copyWithin(to, from, from + count)
    this.fieldIndices.copyWithin(to, from, from + count)
    if (this.positionStarts !== null) this.positionStarts.copyWithin(to, from, from + count)
  }

  byteLength(): number {
    const positionBytes = this.positionStarts === null ? 0 : this.positionStarts.byteLength
    return (
      this.docIds.byteLength +
      this.frequencies.byteLength +
      this.fieldIndices.byteLength +
      positionBytes +
      this.allocation.byteLength +
      this.freeHeads.byteLength
    )
  }

  protected reserve(needed: number): void {
    if (needed <= this.docIds.length) return
    const capacity = grownCapacity(this.docIds.length, needed)
    const docIds = grownCopy(this.docIds, new Uint32Array(capacity), this.end)
    const frequencies = grownCopy(this.frequencies, new Uint16Array(capacity), this.end)
    const fieldIndices = grownCopy(this.fieldIndices, new Uint16Array(capacity), this.end)
    const positionStarts =
      this.positionStarts === null ? null : grownCopy(this.positionStarts, new Uint32Array(capacity), this.end)
    this.docIds = docIds
    this.frequencies = frequencies
    this.fieldIndices = fieldIndices
    this.positionStarts = positionStarts
    this.epoch++
  }
}

function grownCopy<T extends Uint32Array | Uint16Array>(source: T, target: T, used: number): T {
  target.set(source.subarray(0, used))
  return target
}

export class PositionPool {
  values: Uint32Array
  readonly allocation = new Uint32Array([1, 0])

  constructor(capacity: number) {
    requirePoolSize(capacity)
    this.values = new Uint32Array(Math.max(1, capacity))
  }

  get end(): number {
    return this.allocation[ALLOCATION_END]
  }

  set end(value: number) {
    this.allocation[ALLOCATION_END] = value
  }

  get freeValues(): number {
    return this.allocation[ALLOCATION_FREE]
  }

  prepareWrite(needed: number): void {
    this.reserve(needed)
  }

  append(positions: readonly number[]): number {
    const count = positions.length
    if (count === 0) return EMPTY_POSITIONS
    const start = this.end
    this.reserve(start + 1 + count)
    const values = this.values
    values[start] = count
    for (let i = 0; i < count; i++) values[start + 1 + i] = positions[i]
    this.end = start + 1 + count
    return start
  }

  appendFrom(source: PositionPool, start: number): number {
    if (start === EMPTY_POSITIONS) return EMPTY_POSITIONS
    const count = source.values[start]
    const target = this.end
    this.reserve(target + 1 + count)
    this.values.set(source.values.subarray(start, start + 1 + count), target)
    this.end = target + 1 + count
    return target
  }

  countAt(start: number): number {
    return this.values[start]
  }

  read(start: number): number[] {
    const count = this.values[start]
    const out = new Array<number>(count)
    for (let i = 0; i < count; i++) out[i] = this.values[start + 1 + i]
    return out
  }

  copyInto(start: number, target: Uint32Array, offset: number): number {
    const count = this.values[start]
    if (count > 0) target.set(this.values.subarray(start + 1, start + 1 + count), offset)
    return count
  }

  release(start: number): void {
    if (start === EMPTY_POSITIONS) return
    this.allocation[ALLOCATION_FREE] += this.values[start] + 1
  }

  protected reserve(needed: number): void {
    if (needed <= this.values.length) return
    const capacity = grownCapacity(this.values.length, needed)
    const grown = new Uint32Array(capacity)
    grown.set(this.values.subarray(0, this.end))
    this.values = grown
  }
}
