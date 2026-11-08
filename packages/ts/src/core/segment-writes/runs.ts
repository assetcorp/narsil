import type { NativeRunTable } from '../../vector/native/types/segments'
import { FNV_OFFSET_BASIS, FNV_PRIME } from '../hash'
import { PoolPlan, releaseSlice, type Slice } from './pools'
import { requireRoom, requireSegment, SegmentRefusal } from './status'
import type { StringPlan } from './strings'

interface RunMember {
  points: readonly number[]
  spelling: number
}

interface RunChange {
  first: number
  length: number
  ordinal: number
  slot: number
  oldLength: number
  added: boolean
  source: Slice
  target: Slice
}

export function hashRun(points: readonly number[]): number {
  let hash = FNV_OFFSET_BASIS
  for (const point of points) {
    for (let byte = 0; byte < 4; byte++) hash = Math.imul(hash ^ ((point >>> (byte * 8)) & 255), FNV_PRIME)
  }
  return hash >>> 0
}

function compareRuns(left: readonly number[], right: readonly number[]): number {
  for (let at = 0; at < 3; at++) if (left[at] !== right[at]) return left[at] < right[at] ? -1 : 1
  return 0
}

function equalRun(table: NativeRunTable, ordinal: number, points: readonly number[]): boolean {
  for (let at = 0; at < 3; at++) if (table.runs[ordinal * 3 + at] !== points[at]) return false
  return true
}

export function collectRuns(spellings: StringPlan): RunMember[] {
  const members: RunMember[] = []
  for (const entry of spellings.entries) {
    if (!entry.added || entry.points <= 3) continue
    let first = 0
    let second = 0
    let seen = 0
    for (const character of entry.text) {
      const point = character.codePointAt(0) ?? 0
      if (++seen >= 3) members.push({ points: [first, second, point], spelling: entry.ordinal })
      first = second
      second = point
    }
  }
  members.sort((left, right) => compareRuns(left.points, right.points) || left.spelling - right.spelling)
  let kept = 0
  for (const member of members) {
    const previous = members[kept - 1]
    if (
      previous === undefined ||
      compareRuns(previous.points, member.points) !== 0 ||
      previous.spelling !== member.spelling
    )
      members[kept++] = member
  }
  members.length = kept
  return members
}

export class RunPlan {
  private readonly pool: PoolPlan
  private readonly changes: RunChange[] = []
  private readonly placed = new Set<number>()
  private added = 0

  constructor(
    readonly table: NativeRunTable,
    readonly members: readonly RunMember[],
  ) {
    this.pool = new PoolPlan({ ...table, values: table.members })
    for (let first = 0; first < members.length; ) {
      let end = first + 1
      while (end < members.length && compareRuns(members[first].points, members[end].points) === 0) end++
      const source = { start: 0, length: 0, sliceClass: 255 }
      const change: RunChange = {
        first,
        length: end - first,
        ordinal: 0,
        slot: 0,
        oldLength: 0,
        added: false,
        source,
        target: source,
      }
      this.locate(change)
      if (!change.added) this.previousSlice(change)
      requireRoom(change.length <= 0xffffffff - change.oldLength)
      const length = change.oldLength + change.length
      change.target = length > change.source.length ? this.pool.allocate(length) : change.source
      this.changes.push(change)
      first = end
    }
    this.pool.check()
  }

  publish(): void {
    const table = this.table
    this.pool.publish()
    for (const change of this.changes) {
      const ordinal = change.ordinal
      if (change.added) {
        const points = this.members[change.first].points
        for (let at = 0; at < 3; at++) table.runs[ordinal * 3 + at] = points[at]
        table.slots[change.slot] = ordinal + 1
      }
      const target = change.target.start
      if (change.oldLength > 0 && target !== change.source.start)
        table.members.copyWithin(target, change.source.start, change.source.start + change.oldLength)
      for (let at = 0; at < change.length; at++)
        table.members[target + change.oldLength + at] = this.members[change.first + at].spelling
      table.listStart[ordinal] = target
      table.listLength[ordinal] = change.oldLength + change.length
      table.listClass[ordinal] = change.target.sliceClass
    }
    for (const change of this.changes) {
      if (change.source.sliceClass !== 255 && change.source.start !== change.target.start)
        releaseSlice(this.pool.pool, change.source)
    }
    table.header[0] += this.added
  }

  private locate(change: RunChange): void {
    const table = this.table
    const points = this.members[change.first].points
    const mask = table.slots.length - 1
    let slot = hashRun(points) & mask
    let available = -1
    for (let scanned = 0; scanned < table.slots.length; scanned++) {
      if (!this.placed.has(slot)) {
        const entry = table.slots[slot]
        if (entry > 0 && entry <= table.header[0] && equalRun(table, entry - 1, points)) {
          change.ordinal = entry - 1
          change.slot = slot
          return
        }
        if (entry <= 0) {
          if (available < 0) available = slot
          else if (entry === 0) {
            const ordinal = table.header[0] + this.added
            requireRoom(ordinal < table.listStart.length && ordinal < 0x7fffffff)
            change.ordinal = ordinal
            change.slot = available
            change.added = true
            this.placed.add(available)
            this.added++
            return
          }
        }
      }
      slot = (slot + 1) & mask
    }
    requireRoom(false)
  }

  private previousSlice(change: RunChange): void {
    const table = this.table
    const ordinal = change.ordinal
    const sliceClass = table.listClass[ordinal]
    const start = table.listStart[ordinal]
    requireSegment(sliceClass < table.sliceCapacities.length && start <= table.allocation[0])
    const capacity = table.sliceCapacities[sliceClass]
    const length = table.listLength[ordinal]
    requireSegment(capacity <= table.allocation[0] - start && length <= capacity)
    change.source = { start, length: capacity, sliceClass }
    change.oldLength = length
  }
}

function hasSpelling(members: readonly RunMember[], first: number, end: number, spelling: number): boolean {
  let low = first
  let high = end
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (members[middle].spelling < spelling) low = middle + 1
    else high = middle
  }
  return low < end && members[low].spelling === spelling
}

function removalOrdinal(table: NativeRunTable, points: readonly number[]): number {
  const mask = table.slots.length - 1
  let slot = hashRun(points) & mask
  for (let scanned = 0; scanned < table.slots.length; scanned++) {
    const entry = table.slots[slot]
    if (entry === 0) break
    if (entry > 0 && entry <= table.header[0] && equalRun(table, entry - 1, points)) return entry - 1
    slot = (slot + 1) & mask
  }
  throw new SegmentRefusal(1)
}

function checkRemoval(
  table: NativeRunTable,
  ordinal: number,
  members: readonly RunMember[],
  first: number,
  end: number,
): void {
  const start = table.listStart[ordinal]
  const length = table.listLength[ordinal]
  const allocated = table.allocation[0]
  const kind = table.listClass[ordinal]
  requireSegment(
    allocated <= table.members.length &&
      start <= allocated &&
      kind < table.sliceCapacities.length &&
      length <= table.sliceCapacities[kind] &&
      table.sliceCapacities[kind] <= allocated - start,
  )
  let found = first
  for (let at = start; at < start + length; at++) {
    const spelling = table.members[at]
    requireSegment(at === start || spelling > table.members[at - 1])
    if (found < end && spelling === members[found].spelling) found++
  }
  requireSegment(found === end)
}

export function prepareRunRemoval(table: NativeRunTable, members: readonly RunMember[]): () => void {
  const changes: Array<{ ordinal: number; first: number; end: number }> = []
  for (let first = 0; first < members.length; ) {
    let end = first + 1
    while (end < members.length && compareRuns(members[first].points, members[end].points) === 0) end++
    const ordinal = removalOrdinal(table, members[first].points)
    checkRemoval(table, ordinal, members, first, end)
    changes.push({ ordinal, first, end })
    first = end
  }
  changes.sort((left, right) => table.listStart[left.ordinal] - table.listStart[right.ordinal])
  for (let at = 1; at < changes.length; at++) {
    const previous = changes[at - 1].ordinal
    requireSegment(
      table.listStart[previous] + table.sliceCapacities[table.listClass[previous]] <=
        table.listStart[changes[at].ordinal],
    )
  }
  return () => {
    for (const { ordinal, first, end } of changes) {
      const start = table.listStart[ordinal]
      const length = table.listLength[ordinal]
      let kept = 0
      for (let at = start; at < start + length; at++) {
        const spelling = table.members[at]
        if (!hasSpelling(members, first, end, spelling)) table.members[start + kept++] = spelling
      }
      table.listLength[ordinal] = kept
    }
  }
}
