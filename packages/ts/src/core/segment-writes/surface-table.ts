import type { NativeSurfaceTable } from '../../vector/native/types/segments'
import { storedText } from '../stored-values/text'
import { TermTable } from '../term-table'
import { SURFACE_TABLE_START_CAPACITY } from './constants'

export class SurfaceTable implements NativeSurfaceTable {
  readonly strings = new TermTable(SURFACE_TABLE_START_CAPACITY)
  token = new Uint32Array(SURFACE_TABLE_START_CAPACITY)
  count = new Uint32Array(SURFACE_TABLE_START_CAPACITY)

  reserve(entries: number, units: number): void {
    this.prepareCapacity(entries, units).apply()
  }

  textAt(ordinal: number): string {
    return storedText(this.strings.units, this.strings.termOffset[ordinal], this.strings.termLength[ordinal])
  }

  *liveEntries(): IterableIterator<number> {
    for (let ordinal = 0; ordinal < this.strings.header[0]; ordinal++) {
      if (this.count[ordinal] > 0) yield ordinal
    }
  }

  byteLength(): number {
    return this.strings.byteLength() + this.token.byteLength + this.count.byteLength
  }

  protected prepareCapacity(entries: number, units: number): { capacity: number; apply(): void } {
    const prepared = this.strings.prepareCapacity(entries, units)
    const capacity = prepared.capacity
    let token = this.token
    let count = this.count
    if (capacity > token.length) {
      token = new Uint32Array(capacity)
      count = new Uint32Array(capacity)
      token.set(this.token)
      count.set(this.count)
    }
    return {
      capacity,
      apply: () => {
        prepared.apply()
        this.token = token
        this.count = count
      },
    }
  }
}
