import type { NativeSliceAllocator } from '../../vector/native/types/segments'
import { requireRoom, requireSegment } from './status'

export interface Slice {
  start: number
  length: number
  sliceClass: number
}

export interface SlicePool extends NativeSliceAllocator {
  values: Uint32Array
}

export class PoolPlan {
  readonly heads: Uint32Array
  private readonly slices: Slice[] = []
  private readonly used = new Set<number>()
  private end: number
  private free: number

  constructor(readonly pool: SlicePool) {
    requireSegment(
      pool.values.length <= 0xffffffff &&
        pool.sliceCapacities.length > 0 &&
        pool.sliceCapacities.length <= 255 &&
        pool.allocation[0] <= pool.values.length &&
        pool.allocation[1] <= pool.allocation[0],
    )
    let previous = 0
    for (const capacity of pool.sliceCapacities) {
      requireSegment(capacity > previous)
      previous = capacity
    }
    this.heads = pool.freeHeads.slice()
    this.end = pool.allocation[0]
    this.free = pool.allocation[1]
  }

  allocate(length: number): Slice {
    const pool = this.pool
    let low = 0
    let high = pool.sliceCapacities.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (pool.sliceCapacities[middle] < length) low = middle + 1
      else high = middle
    }
    requireSegment(low < pool.sliceCapacities.length && length > 0)
    const size = pool.sliceCapacities[low]
    let start = this.heads[low]
    const reused = start !== 0xffffffff
    if (reused) {
      requireSegment(start < pool.allocation[0] && size <= pool.allocation[0] - start && size <= this.free)
    } else {
      start = this.end
      requireRoom(size <= pool.values.length - start)
    }
    requireSegment(!this.used.has(start))
    this.used.add(start)
    const slice = { start, length: size, sliceClass: low }
    this.slices.push(slice)
    if (reused) {
      this.heads[low] = pool.values[start]
      this.free -= size
    } else this.end += size
    return slice
  }

  check(): void {
    this.slices.sort((left, right) => left.start - right.start)
    for (let at = 1; at < this.slices.length; at++) {
      const previous = this.slices[at - 1]
      requireSegment(this.slices[at].start - previous.start >= previous.length)
    }
  }

  publish(): void {
    this.pool.allocation[0] = this.end
    this.pool.allocation[1] = this.free
    this.pool.freeHeads.set(this.heads)
  }
}

export function releaseSlice(pool: SlicePool, slice: Slice): void {
  if (slice.sliceClass === 255) return
  pool.values[slice.start] = pool.freeHeads[slice.sliceClass]
  pool.freeHeads[slice.sliceClass] = slice.start
  pool.allocation[1] += slice.length
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
      releaseSlice(pool, { start, length: size, sliceClass: at })
      start += size
      remaining -= size
    }
  }
}
