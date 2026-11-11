import type { ShardEntryRange } from '../../core/doc-id-tables/types'
import {
  MAP_TABLE_HEADER_BYTES,
  MAP_TABLE_MIN_CAPACITY,
  MAP_TABLE_SHRINK_DIVISOR,
  MAP_TABLE_SLOT_BYTES,
} from './constants'

export interface TableModel {
  entries: number
  churn: number
  deleted: number
  resetEntries: number
  resetDeleted: number
  resetSmallestCapacity: number
  resetLargestCapacity: number
  addedAtLeast: number
  addedAtMost: number
  deletedSinceRehashBecamePossible: number | null
}

export function capacityFor(entries: number): number {
  if (entries <= MAP_TABLE_MIN_CAPACITY) return MAP_TABLE_MIN_CAPACITY
  return 2 ** Math.ceil(Math.log2(entries))
}

function largestCapacityFor(entries: number): number {
  return Math.max(capacityFor(entries), 2 ** Math.floor(Math.log2(MAP_TABLE_SHRINK_DIVISOR * (entries + 1))))
}

function resetModel(model: TableModel, shape: ShardEntryRange, deleted: number): void {
  model.deleted = deleted
  model.resetEntries = shape.largest
  model.resetDeleted = deleted
  model.resetSmallestCapacity = capacityFor(shape.smallest)
  model.resetLargestCapacity = largestCapacityFor(shape.largest)
  model.addedAtLeast = 0
  model.addedAtMost = 0
  model.deletedSinceRehashBecamePossible = null
}

export function createTableModel(entries: number, churn: number, deleted: number, shape: ShardEntryRange): TableModel {
  const model: TableModel = {
    entries,
    churn,
    deleted,
    resetEntries: 0,
    resetDeleted: 0,
    resetSmallestCapacity: 0,
    resetLargestCapacity: 0,
    addedAtLeast: 0,
    addedAtMost: 0,
    deletedSinceRehashBecamePossible: null,
  }
  resetModel(model, shape, deleted)
  return model
}

export function observeTable(model: TableModel, entries: number, churn: number, shape: ShardEntryRange): void {
  const churned = Math.max(0, churn - model.churn)
  const change = entries - model.entries
  const deleted = Math.max(churned, -change)
  const lowest = Math.max(0, Math.min(model.entries, entries) - deleted)
  model.entries = entries
  model.churn = churn
  model.deleted += deleted
  model.addedAtLeast += Math.max(0, change)
  model.addedAtMost += Math.max(0, change) + churned
  if (entries === 0) {
    resetModel(model, shape, Math.min(model.deleted, MAP_TABLE_MIN_CAPACITY))
    return
  }
  if (shape.shards !== 1) return
  if (model.deletedSinceRehashBecamePossible !== null) {
    model.deletedSinceRehashBecamePossible += deleted
  } else if (
    model.resetEntries + model.resetDeleted + model.addedAtMost >= model.resetSmallestCapacity ||
    lowest < model.resetLargestCapacity / MAP_TABLE_SHRINK_DIVISOR
  ) {
    model.deletedSinceRehashBecamePossible = deleted
  }
  if (
    model.addedAtLeast > model.resetLargestCapacity - model.resetEntries ||
    entries < model.resetSmallestCapacity / MAP_TABLE_SHRINK_DIVISOR
  ) {
    resetModel(model, shape, model.deletedSinceRehashBecamePossible ?? model.deleted)
  }
}

export function tableGrowthBytes(model: TableModel, shape: ShardEntryRange, added: number): number {
  if (added <= 0) return 0
  const largestCapacity = largestCapacityFor(shape.largest)
  let grownBytes = 0
  for (let capacity = capacityFor(shape.smallest); capacity <= largestCapacity; capacity *= 2) {
    const lastOccupied = shape.largest + added - 1
    const deletedSlots = Math.max(0, Math.min(model.deleted, capacity - shape.largest))
    if (lastOccupied + deletedSlots < capacity) continue
    const entriesAfter = shape.largest + added
    const rebuildsAtSize = deletedSlots >= capacity / 2
    const doubles = lastOccupied + Math.min(deletedSlots, capacity / 2 - 1) >= capacity
    const rebuiltBytes = rebuildsAtSize ? allocatedTableBytes(capacity, entriesAfter) : 0
    const doubledBytes = doubles ? allocatedTableBytes(capacity * 2, entriesAfter) : 0
    grownBytes = Math.max(grownBytes, rebuiltBytes, doubledBytes)
  }
  return shape.shards * grownBytes
}

function allocatedTableBytes(firstCapacity: number, entriesAfter: number): number {
  let capacity = firstCapacity
  let bytes = MAP_TABLE_HEADER_BYTES + MAP_TABLE_SLOT_BYTES * capacity
  while (entriesAfter > capacity) {
    capacity *= 2
    bytes += MAP_TABLE_HEADER_BYTES + MAP_TABLE_SLOT_BYTES * capacity
  }
  return bytes
}
