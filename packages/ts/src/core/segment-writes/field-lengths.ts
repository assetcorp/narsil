import { ErrorCodes, NarsilError } from '../../errors'
import { grownCapacity } from '../inverted-index/pools'

const LAST_ORDINAL_CAPACITY = 0xffffffff
const FIELD_COUNT = 0x10000

export class FieldLengths {
  values = new Uint32Array(0)
  totals = new Float64Array(0)
  partial = new Uint8Array(0)
  readonly documents = new Uint32Array(1)
  ordinalCapacity = 0

  reserve(ordinals: number, fields: number): void {
    if (
      !Number.isInteger(ordinals) ||
      ordinals < 0 ||
      ordinals > LAST_ORDINAL_CAPACITY ||
      !Number.isInteger(fields) ||
      fields < this.partial.length ||
      fields > FIELD_COUNT
    )
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The field length columns exceed their ordinal layout')
    const capacity =
      ordinals > this.ordinalCapacity ? grownCapacity(this.ordinalCapacity, ordinals) : this.ordinalCapacity
    if (capacity === this.ordinalCapacity && fields === this.partial.length) return
    const values = new Uint32Array(capacity * fields)
    const totals = new Float64Array(fields)
    const partial = new Uint8Array(fields)
    for (let field = 0; field < this.partial.length; field++) {
      const start = field * this.ordinalCapacity
      values.set(this.values.subarray(start, start + this.ordinalCapacity), field * capacity)
    }
    totals.set(this.totals)
    partial.set(this.partial)
    this.values = values
    this.totals = totals
    this.partial = partial
    this.ordinalCapacity = capacity
  }

  byteLength(): number {
    return this.values.byteLength + this.totals.byteLength + this.partial.byteLength + this.documents.byteLength
  }
}
