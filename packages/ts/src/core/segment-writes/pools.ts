import type { NativeSliceAllocator } from '../../vector/native/types/segments'
import { SLICE_CAPACITIES } from '../inverted-index/pools'
import { WRITE_PLAN_START_CAPACITY } from './constants'
import { requireRoom, requireSegment } from './status'

export interface Slice {
  start: number
  length: number
  sliceClass: number
}

export interface SlicePool extends NativeSliceAllocator {
  values: Uint32Array
}

const MAX_SLICE_CLASSES = 255
const NO_SLICE_CLASS = 255
const NO_FREE_SLICE = 0xffffffff
const SLICE_CLASS_SPAN = 256
const LAST_STAMP = 0xffffffff

const UNSET_ALLOCATOR: NativeSliceAllocator = {
  allocation: new Uint32Array(2),
  freeHeads: new Uint32Array(0),
  sliceCapacities: new Uint32Array(0),
}

function readsEngineCapacities(capacities: Uint32Array): boolean {
  return (
    capacities.buffer === SLICE_CAPACITIES.buffer &&
    capacities.byteOffset === SLICE_CAPACITIES.byteOffset &&
    capacities.length === SLICE_CAPACITIES.length
  )
}

export class PoolPlan {
  allocator = UNSET_ALLOCATOR
  values: Uint32Array = new Uint32Array(0)
  allocatedClass = 0
  readonly heads = new Uint32Array(MAX_SLICE_CLASSES)
  private slices = new Float64Array(WRITE_PLAN_START_CAPACITY)
  private count = 0
  private usedStarts = new Uint32Array(WRITE_PLAN_START_CAPACITY * 2)
  private usedStamps = new Uint32Array(WRITE_PLAN_START_CAPACITY * 2)
  private stamp = 0
  private end = 0
  private free = 0

  begin(allocator: NativeSliceAllocator, values: Uint32Array): this {
    const capacities = allocator.sliceCapacities
    requireSegment(
      values.length <= 0xffffffff &&
        capacities.length > 0 &&
        capacities.length <= MAX_SLICE_CLASSES &&
        allocator.allocation[0] <= values.length &&
        allocator.allocation[1] <= allocator.allocation[0],
    )
    if (!readsEngineCapacities(capacities)) {
      let previous = 0
      for (let at = 0; at < capacities.length; at++) {
        requireSegment(capacities[at] > previous)
        previous = capacities[at]
      }
    }
    this.allocator = allocator
    this.values = values
    this.heads.set(allocator.freeHeads.subarray(0, capacities.length))
    this.end = allocator.allocation[0]
    this.free = allocator.allocation[1]
    this.count = 0
    this.nextStamp()
    return this
  }

  allocateStart(length: number, smallerClass = NO_SLICE_CLASS): number {
    const capacities = this.allocator.sliceCapacities
    const allocation = this.allocator.allocation
    let low = 0
    if (smallerClass < capacities.length && capacities[smallerClass] < length) {
      low = smallerClass + 1
      while (low < capacities.length && capacities[low] < length) low++
    } else if (capacities[0] < length) {
      let high = capacities.length
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2)
        if (capacities[middle] < length) low = middle + 1
        else high = middle
      }
    }
    requireSegment(low < capacities.length && length > 0)
    const size = capacities[low]
    let start = this.heads[low]
    const reused = start !== NO_FREE_SLICE
    if (reused) {
      requireSegment(start < allocation[0] && size <= allocation[0] - start && size <= this.free)
    } else {
      start = this.end
      requireRoom(size <= this.values.length - start)
    }
    if (reused) {
      this.record(start, low)
      this.heads[low] = this.values[start]
      this.free -= size
    } else this.end += size
    this.allocatedClass = low
    return start
  }

  allocate(length: number): Slice {
    const start = this.allocateStart(length)
    const sliceClass = this.allocatedClass
    return { start, length: this.allocator.sliceCapacities[sliceClass], sliceClass }
  }

  check(): void {
    const capacities = this.allocator.sliceCapacities
    const slices = this.slices.subarray(0, this.count)
    slices.sort()
    for (let at = 1; at < slices.length; at++) {
      const previousClass = slices[at - 1] % SLICE_CLASS_SPAN
      const previousStart = (slices[at - 1] - previousClass) / SLICE_CLASS_SPAN
      const start = (slices[at] - (slices[at] % SLICE_CLASS_SPAN)) / SLICE_CLASS_SPAN
      requireSegment(start - previousStart >= capacities[previousClass])
    }
  }

  publish(): void {
    const allocator = this.allocator
    allocator.allocation[0] = this.end
    allocator.allocation[1] = this.free
    allocator.freeHeads.set(this.heads.subarray(0, allocator.freeHeads.length))
  }

  private record(start: number, sliceClass: number): void {
    if ((this.count + 1) * 2 > this.usedStarts.length) this.growUsed()
    const mask = this.usedStarts.length - 1
    let slot = start & mask
    while (this.usedStamps[slot] === this.stamp) {
      requireSegment(this.usedStarts[slot] !== start)
      slot = (slot + 1) & mask
    }
    this.usedStamps[slot] = this.stamp
    this.usedStarts[slot] = start
    if (this.count === this.slices.length) {
      const grown = new Float64Array(this.slices.length * 2)
      grown.set(this.slices)
      this.slices = grown
    }
    this.slices[this.count++] = start * SLICE_CLASS_SPAN + sliceClass
  }

  private growUsed(): void {
    const capacity = this.usedStarts.length * 2
    this.usedStarts = new Uint32Array(capacity)
    this.usedStamps = new Uint32Array(capacity)
    this.stamp = 1
    const mask = capacity - 1
    for (let at = 0; at < this.count; at++) {
      const start = (this.slices[at] - (this.slices[at] % SLICE_CLASS_SPAN)) / SLICE_CLASS_SPAN
      let slot = start & mask
      while (this.usedStamps[slot] === this.stamp) slot = (slot + 1) & mask
      this.usedStamps[slot] = this.stamp
      this.usedStarts[slot] = start
    }
  }

  private nextStamp(): void {
    if (this.stamp === LAST_STAMP) {
      this.usedStamps.fill(0)
      this.stamp = 0
    }
    this.stamp++
  }
}

export function releaseRange(
  allocator: NativeSliceAllocator,
  values: Uint32Array,
  start: number,
  length: number,
  sliceClass: number,
): void {
  if (sliceClass === NO_SLICE_CLASS) return
  values[start] = allocator.freeHeads[sliceClass]
  allocator.freeHeads[sliceClass] = start
  allocator.allocation[1] += length
}

export function releaseSlice(pool: SlicePool, slice: Slice): void {
  releaseRange(pool, pool.values, slice.start, slice.length, slice.sliceClass)
}

export function trimClass(capacities: Uint32Array, source: number, kept: number): number {
  let previous = 0
  for (let at = 0; at <= source; at++) {
    requireSegment(capacities[at] > previous)
    previous = capacities[at]
  }
  let target = 0
  while (target < source && capacities[target] < kept) target++
  let remaining = capacities[source] - capacities[target]
  let pieces = 0
  for (let at = source; at >= 0; at--) {
    const size = capacities[at]
    pieces += Math.floor(remaining / size)
    if (pieces > capacities.length) return source
    remaining %= size
  }
  return remaining === 0 ? target : source
}

export function trimSlice(pool: SlicePool, source: Slice, target: number): void {
  const held = pool.sliceCapacities[target]
  let start = source.start + held
  let remaining = source.length - held
  for (let at = source.sliceClass; at >= 0 && remaining > 0; at--) {
    const size = pool.sliceCapacities[at]
    while (size <= remaining) {
      releaseRange(pool, pool.values, start, size, at)
      start += size
      remaining -= size
    }
  }
}
