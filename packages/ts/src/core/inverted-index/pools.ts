import { POOL_GROWTH_FACTOR, SLICE_GROWTH_FACTOR } from './constants'

export const NO_SLICE = 255
export const EMPTY_POSITIONS = 0
const MAX_POOL_ENTRIES = 2 ** 32 - 1

const SLICE_CAPACITIES = ((): Uint32Array => {
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

function grownCapacity(current: number, needed: number): number {
  return Math.min(MAX_POOL_ENTRIES, Math.max(needed, Math.ceil(current * POOL_GROWTH_FACTOR)))
}

export class PostingPool {
  docIds: Uint32Array
  frequencies: Uint16Array
  fieldIndices: Uint16Array
  positionStarts: Uint32Array | null = null
  end = 0
  epoch = 0
  freeEntries = 0
  private freeLists: number[][] = []

  constructor(capacity: number) {
    this.docIds = new Uint32Array(capacity)
    this.frequencies = new Uint16Array(capacity)
    this.fieldIndices = new Uint16Array(capacity)
  }

  allocate(sliceClass: number): number {
    const size = sliceCapacity(sliceClass)
    const free = this.freeLists[sliceClass]
    if (free !== undefined) {
      const reused = free.pop()
      if (reused !== undefined) {
        this.freeEntries -= size
        return reused
      }
    }
    const start = this.end
    this.reserve(start + size)
    this.end = start + size
    return start
  }

  release(start: number, sliceClass: number): void {
    if (sliceClass === NO_SLICE) return
    let free = this.freeLists[sliceClass]
    if (free === undefined) {
      free = []
      this.freeLists[sliceClass] = free
    }
    free.push(start)
    this.freeEntries += sliceCapacity(sliceClass)
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
    return this.docIds.byteLength + this.frequencies.byteLength + this.fieldIndices.byteLength + positionBytes
  }

  private reserve(needed: number): void {
    if (needed <= this.docIds.length) return
    const capacity = grownCapacity(this.docIds.length, needed)
    this.docIds = grownCopy(this.docIds, new Uint32Array(capacity), this.end)
    this.frequencies = grownCopy(this.frequencies, new Uint16Array(capacity), this.end)
    this.fieldIndices = grownCopy(this.fieldIndices, new Uint16Array(capacity), this.end)
    if (this.positionStarts !== null) {
      this.positionStarts = grownCopy(this.positionStarts, new Uint32Array(capacity), this.end)
    }
    this.epoch++
  }
}

function grownCopy<T extends Uint32Array | Uint16Array>(source: T, target: T, used: number): T {
  target.set(source.subarray(0, used))
  return target
}

export class PositionPool {
  values: Uint32Array
  end = 1
  freeValues = 0

  constructor(capacity: number) {
    this.values = new Uint32Array(Math.max(1, capacity))
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
    this.freeValues += this.values[start] + 1
  }

  private reserve(needed: number): void {
    if (needed <= this.values.length) return
    const capacity = grownCapacity(this.values.length, needed)
    const grown = new Uint32Array(capacity)
    grown.set(this.values.subarray(0, this.end))
    this.values = grown
  }
}
