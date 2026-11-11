import * as Layout from '../../core/filters/layout'
import { checkedSize } from '../../core/stored-values/storage'
import { parsedTypeOf } from '../../schema/validator/field-type'
import type { FilterContext } from '../context'

export class FilterBuilder {
  readonly instructions: number[] = []
  readonly numbers: number[] = []
  readonly strings: string[] = []
  readonly lists: number[] = []
  readonly bitsets: Uint32Array[] = []
  readonly kinds: number[] = []
  readonly fields: Layout.FilterRegion[][] = []
  private readonly fieldIds = new Map<string, number>()
  private readonly sizeIds = new Map<string, number>()

  constructor(readonly context: FilterContext) {}

  emit(opcode: number, field = 0, operator = 0, operand = 0): void {
    this.instructions.push(opcode, field, operator, operand)
  }

  bitset(value: Uint32Array): void {
    this.emit(Layout.FILTER_BITSET, 0, 0, this.bitsets.length)
    this.bitsets.push(value)
  }

  field(path: string, size = false): number {
    const ids = size ? this.sizeIds : this.fieldIds
    const held = ids.get(path)
    if (held !== undefined) return held
    const field = this.fields.length
    const regions: Layout.FilterRegion[] = [this.context.presentBitset(path)]
    let kind = Layout.FILTER_ABSENT
    const numeric = size ? this.context.sizeIndex(path) : this.context.numericIndex(path)
    const boolean = size ? undefined : this.context.booleanIndex(path)
    const enumeration = size ? undefined : this.context.enumIndex(path)
    const geo = size ? undefined : this.context.geoIndex(path)
    if (numeric !== undefined) {
      const values = numeric.regions()
      kind = Layout.FILTER_NUMERIC
      regions.push(values.values, values.ordinals)
    } else if (boolean !== undefined) {
      const values = boolean.regions(this.context.capacity)
      kind = Layout.FILTER_BOOLEAN
      regions.push(values.trueBits, values.falseBits)
    } else if (enumeration !== undefined) {
      const values = enumeration.regions()
      kind = Layout.FILTER_ENUM
      regions.push(values.units, values.offsets, values.postingOffsets, values.postings, values.suffixOrder)
    } else if (geo !== undefined) {
      const values = geo.regions()
      kind = Layout.FILTER_GEO
      regions.push(values.codes, values.lat, values.lon, values.ordinals)
    } else {
      const base = parsedTypeOf(this.context.fieldTypes[path])?.base
      if (size || base === 'number' || base === 'number[]') {
        kind = Layout.FILTER_NUMERIC
        regions.push(new Float64Array(0), new Uint32Array(0))
      } else if (base === 'boolean' || base === 'boolean[]') {
        kind = Layout.FILTER_BOOLEAN
        regions.push(new Uint32Array(1), new Uint32Array(1))
      } else if (base === 'enum' || base === 'enum[]') {
        kind = Layout.FILTER_ENUM
        regions.push(new Uint16Array(0), new Uint32Array(1), new Uint32Array(1), new Uint32Array(0), new Uint32Array(0))
      } else if (base === 'geopoint') {
        kind = Layout.FILTER_GEO
        regions.push(new BigUint64Array(0), new Float64Array(0), new Float64Array(0), new Uint32Array(0))
      }
    }
    ids.set(path, field)
    this.fields.push(regions)
    this.kinds.push(kind)
    return field
  }

  test(
    field: number,
    operator: number,
    value: number | boolean | string | readonly (number | boolean | string)[],
  ): void {
    let operand: number
    if (typeof value === 'string') {
      operand = this.strings.length
      this.strings.push(value)
    } else if (Array.isArray(value) && (this.kinds[field] === Layout.FILTER_ENUM || typeof value[0] === 'string')) {
      operand = this.lists.length / 2
      this.lists.push(this.strings.length, value.length)
      for (const text of value as string[]) this.strings.push(text)
    } else {
      operand = this.numbers.length
      if (Array.isArray(value)) {
        if (operator === Layout.FILTER_ANY || operator === Layout.FILTER_ALL) this.numbers.push(value.length)
        for (const entry of value) this.numbers.push(Number(entry))
      } else this.numbers.push(Number(value))
    }
    this.emit(Layout.FILTER_TEST, field, operator, operand)
  }

  finish(): Layout.FilterProgram {
    const offsets = new Uint32Array(this.strings.length + 1)
    let length = 0
    for (let at = 0; at < this.strings.length; at++)
      offsets[at + 1] = length = checkedSize(length + this.strings[at].length)
    const units = new Uint16Array(length)
    for (let at = 0; at < this.strings.length; at++) {
      const text = this.strings[at]
      for (let unit = 0; unit < text.length; unit++) units[offsets[at] + unit] = text.charCodeAt(unit)
    }
    return {
      plan: Uint32Array.from(this.instructions),
      numbers: Float64Array.from(this.numbers),
      units,
      offsets,
      lists: Uint32Array.from(this.lists),
      bitsets: this.bitsets,
      kinds: Uint8Array.from(this.kinds),
      fields: this.fields,
      live: this.context.allDocIdsBitset,
    }
  }
}
