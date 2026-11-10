import { POSTING_MERGE_GROWTH_FACTOR, POSTING_MERGE_START_ROWS } from './constants'

export class PostingRows {
  targets = new Uint32Array(POSTING_MERGE_START_ROWS)
  fields = new Uint16Array(POSTING_MERGE_START_ROWS)
  sources = new Uint32Array(POSTING_MERGE_START_ROWS)
  rows = new Uint32Array(POSTING_MERGE_START_ROWS)
  order = new Uint32Array(POSTING_MERGE_START_ROWS)
  count = 0
  ordered = true

  reset(capacity: number): void {
    this.count = 0
    this.ordered = true
    if (capacity <= this.targets.length) return
    const size = Math.max(capacity, this.targets.length * POSTING_MERGE_GROWTH_FACTOR)
    this.targets = new Uint32Array(size)
    this.fields = new Uint16Array(size)
    this.sources = new Uint32Array(size)
    this.rows = new Uint32Array(size)
    this.order = new Uint32Array(size)
  }

  push(target: number, field: number, source: number, row: number): void {
    const at = this.count
    if (at > 0 && this.ordered) {
      const before = at - 1
      const order =
        this.targets[before] - target ||
        this.fields[before] - field ||
        this.sources[before] - source ||
        this.rows[before] - row
      if (order > 0) this.ordered = false
    }
    this.targets[at] = target
    this.fields[at] = field
    this.sources[at] = source
    this.rows[at] = row
    this.count = at + 1
  }

  sequence(): Uint32Array {
    const order = this.order.subarray(0, this.count)
    for (let at = 0; at < this.count; at++) order[at] = at
    if (this.ordered) return order
    const { targets, fields, sources, rows } = this
    order.sort(
      (left, right) =>
        targets[left] - targets[right] ||
        fields[left] - fields[right] ||
        sources[left] - sources[right] ||
        rows[left] - rows[right],
    )
    return order
  }
}
