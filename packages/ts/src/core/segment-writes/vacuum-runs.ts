import type { NativeRunTable } from '../../vector/native/types/segments'
import { hashRun } from './runs'
import { requireSegment } from './status'

interface VacuumRun {
  points: number[]
  start: number
  length: number
  sliceClass: number
}

export class RunVacuum {
  private readonly runs: VacuumRun[] = []
  private readonly members: Uint32Array
  private readonly slices: Array<{ start: number; length: number }> = []
  private memberCount = 0
  private readonly sourceCount: number

  constructor(
    private readonly table: NativeRunTable,
    private readonly mapping: Uint32Array,
  ) {
    this.sourceCount = table.header[0]
    const end = table.allocation[0]
    requireSegment(end <= table.members.length && table.allocation[1] <= end)
    let previous = 0
    for (const capacity of table.sliceCapacities) {
      requireSegment(capacity > previous)
      previous = capacity
    }
    this.members = new Uint32Array(end)
    for (let at = 0; at < this.sourceCount; at++) this.collect(at)
    requireSegment(this.runs.length < table.slots.length)
    this.slices.sort((left, right) => left.start - right.start)
    for (let at = 1; at < this.slices.length; at++)
      requireSegment(this.slices[at].start - this.slices[at - 1].start >= this.slices[at - 1].length)
  }

  private validSlot(ordinal: number, points: readonly number[]): boolean {
    const table = this.table
    const mask = table.slots.length - 1
    let slot = hashRun(points) & mask
    for (let seen = 0; seen < table.slots.length; seen++) {
      const entry = table.slots[slot]
      if (entry === 0) return false
      if (
        entry > 0 &&
        entry <= this.sourceCount &&
        points.every((point, at) => point === table.runs[(entry - 1) * 3 + at])
      )
        return entry - 1 === ordinal
      slot = (slot + 1) & mask
    }
    return false
  }

  private collect(ordinal: number): void {
    const table = this.table
    const start = table.listStart[ordinal]
    const length = table.listLength[ordinal]
    const end = table.allocation[0]
    const kind = table.listClass[ordinal]
    const points = Array.from(table.runs.subarray(ordinal * 3, ordinal * 3 + 3))
    requireSegment(kind < table.sliceCapacities.length && start <= end && this.validSlot(ordinal, points))
    const size = table.sliceCapacities[kind]
    requireSegment(size <= end - start && length <= size)
    this.slices.push({ start, length: size })
    const run: VacuumRun = { points, start: this.memberCount, length: 0, sliceClass: 0 }
    for (let at = start; at < start + length; at++) {
      const member = table.members[at]
      requireSegment(member < this.mapping.length && (at === start || table.members[at - 1] < member))
      const target = this.mapping[member]
      if (target === 0xffffffff) continue
      requireSegment(this.memberCount < end)
      this.members[this.memberCount++] = target
      run.length++
    }
    if (run.length === 0) return
    while (run.sliceClass < table.sliceCapacities.length && table.sliceCapacities[run.sliceClass] < run.length)
      run.sliceClass++
    requireSegment(
      run.sliceClass < table.sliceCapacities.length && table.sliceCapacities[run.sliceClass] <= end - run.start,
    )
    this.memberCount = run.start + table.sliceCapacities[run.sliceClass]
    this.runs.push(run)
  }

  publish(): void {
    const table = this.table
    table.slots.fill(0)
    const mask = table.slots.length - 1
    for (let at = 0; at < this.runs.length; at++) {
      const run = this.runs[at]
      table.runs.set(run.points, at * 3)
      let slot = hashRun(run.points) & mask
      while (table.slots[slot] !== 0) slot = (slot + 1) & mask
      table.slots[slot] = at + 1
      table.listStart[at] = run.start
      table.listLength[at] = run.length
      table.listClass[at] = run.sliceClass
      table.members.set(this.members.subarray(run.start, run.start + run.length), run.start)
    }
    table.listLength.fill(0, this.runs.length, this.sourceCount)
    table.header[0] = this.runs.length
    table.allocation[0] = this.memberCount
    table.allocation[1] = 0
    table.freeHeads.fill(0xffffffff)
  }
}
