import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeRunTable } from '../../vector/native/types/segments'
import { FNV_OFFSET_BASIS, FNV_PRIME } from '../hash'
import { grownCapacity, SLICE_CAPACITIES } from '../inverted-index/pools'
import {
  TERM_REGION_GROWTH_FACTOR,
  TERM_SLOT_LOAD_DENOMINATOR,
  TERM_SLOT_LOAD_NUMERATOR,
} from '../term-table/constants'
import { RUN_MEMBER_START_CAPACITY, RUN_TABLE_START_CAPACITY } from './constants'

const COUNT = 0
const SLOT_CAPACITY = 2
const HEADER_WORDS = 8
const RUN_POINTS = 3
const LAST_SLOT_CAPACITY = 0x80000000
const LAST_RUN_COUNT = 0x7fffffff
const NO_FREE_SLICE = 0xffffffff

function hashRun(runs: Uint32Array, at: number): number {
  let hash = FNV_OFFSET_BASIS
  for (let index = at; index < at + RUN_POINTS; index++) {
    const point = runs[index]
    for (let byte = 0; byte < 4; byte++) hash = Math.imul(hash ^ ((point >>> (byte * 8)) & 255), FNV_PRIME)
  }
  return hash >>> 0
}

export class RunTable implements NativeRunTable {
  readonly header = new Uint32Array(HEADER_WORDS)
  slots: Int32Array = new Int32Array(RUN_TABLE_START_CAPACITY * TERM_REGION_GROWTH_FACTOR)
  runs = new Uint32Array(RUN_TABLE_START_CAPACITY * RUN_POINTS)
  listStart = new Uint32Array(RUN_TABLE_START_CAPACITY)
  listLength = new Uint32Array(RUN_TABLE_START_CAPACITY)
  listClass = new Uint8Array(RUN_TABLE_START_CAPACITY)
  members = new Uint32Array(RUN_MEMBER_START_CAPACITY)
  readonly allocation = new Uint32Array(2)
  readonly freeHeads = new Uint32Array(SLICE_CAPACITIES.length).fill(NO_FREE_SLICE)
  readonly sliceCapacities = SLICE_CAPACITIES

  constructor() {
    this.header[SLOT_CAPACITY] = this.slots.length
  }

  reserve(count: number, members: number): void {
    if (!Number.isInteger(count) || count < this.header[COUNT] || count > LAST_RUN_COUNT)
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The run table exceeds its slot layout')
    let slots = this.slots
    let slotCapacity = slots.length
    while (count * TERM_SLOT_LOAD_DENOMINATOR >= slotCapacity * TERM_SLOT_LOAD_NUMERATOR) {
      slotCapacity *= TERM_REGION_GROWTH_FACTOR
      if (slotCapacity > LAST_SLOT_CAPACITY)
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The run table exceeds its slot layout')
    }
    if (slotCapacity > slots.length) slots = this.rehash(slotCapacity)
    let runs = this.runs
    let starts = this.listStart
    let lengths = this.listLength
    let classes = this.listClass
    if (count > starts.length) {
      const capacity = Math.min(LAST_RUN_COUNT, Math.max(count, starts.length * TERM_REGION_GROWTH_FACTOR))
      runs = new Uint32Array(capacity * RUN_POINTS)
      starts = new Uint32Array(capacity)
      lengths = new Uint32Array(capacity)
      classes = new Uint8Array(capacity)
      runs.set(this.runs)
      starts.set(this.listStart)
      lengths.set(this.listLength)
      classes.set(this.listClass)
    }
    let values = this.members
    if (members > values.length) {
      values = new Uint32Array(grownCapacity(values.length, members))
      values.set(this.members.subarray(0, this.allocation[0]))
    }
    this.slots = slots
    this.header[SLOT_CAPACITY] = slotCapacity
    this.runs = runs
    this.listStart = starts
    this.listLength = lengths
    this.listClass = classes
    this.members = values
  }

  byteLength(): number {
    return (
      this.header.byteLength +
      this.slots.byteLength +
      this.runs.byteLength +
      this.listStart.byteLength +
      this.listLength.byteLength +
      this.listClass.byteLength +
      this.members.byteLength +
      this.allocation.byteLength +
      this.freeHeads.byteLength
    )
  }

  trim(): void {
    const count = Math.max(RUN_TABLE_START_CAPACITY, this.header[COUNT])
    let capacity = RUN_TABLE_START_CAPACITY * TERM_REGION_GROWTH_FACTOR
    while (count * TERM_SLOT_LOAD_DENOMINATOR >= capacity * TERM_SLOT_LOAD_NUMERATOR)
      capacity *= TERM_REGION_GROWTH_FACTOR
    const columns = {
      slots: capacity < this.slots.length ? this.rehash(capacity) : this.slots,
      runs: this.runs.slice(0, count * RUN_POINTS),
      listStart: this.listStart.slice(0, count),
      listLength: this.listLength.slice(0, count),
      listClass: this.listClass.slice(0, count),
      members: this.members.slice(0, Math.max(RUN_MEMBER_START_CAPACITY, this.allocation[0])),
    }
    Object.assign(this, columns)
    this.header[SLOT_CAPACITY] = this.slots.length
  }

  private rehash(capacity: number): Int32Array {
    const slots = new Int32Array(capacity)
    const mask = capacity - 1
    for (const entry of this.slots) {
      if (entry <= 0) continue
      let slot = hashRun(this.runs, (entry - 1) * RUN_POINTS) & mask
      while (slots[slot] !== 0) slot = (slot + 1) & mask
      slots[slot] = entry
    }
    return slots
  }
}
