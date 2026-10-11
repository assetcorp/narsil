import { bitsetAndInto, bitsetAndNotInto, bitsetFromSet, bitsetOrInto, createBitSet } from '../core/bitset'
import type { BooleanFieldIndexReader, EnumFieldIndexReader, NumericFieldIndexReader } from '../core/field-index'
import type { TextRangeBounds } from '../core/partition/sort-columns/range'
import type { GeoIndexReader } from '../geo/geo-index'
import type { ParsedFieldType } from '../schema/validator/field-type'
import type { GeoPolygonFilter, GeoRadiusFilter } from '../types/filters'
import type { FieldType } from '../types/schema'
import { GEO_UNIT_METRES } from './constants'
import { evaluatePatternTests, type PatternFilterContext } from './pattern-tests'

export interface FilterContext extends PatternFilterContext {
  readonly fieldTypes: Readonly<Record<string, FieldType>>
  numericIndex(fieldPath: string): NumericFieldIndexReader | undefined
  booleanIndex(fieldPath: string): BooleanFieldIndexReader | undefined
  enumIndex(fieldPath: string): EnumFieldIndexReader | undefined
  geoIndex(fieldPath: string): GeoIndexReader | undefined
  sizeIndex(fieldPath: string): NumericFieldIndexReader | undefined
  textRangeBitset(fieldPath: string, bounds: TextRangeBounds): Uint32Array
}

type Narrow = (bits: Uint32Array) => void
type Scalar = string | number | boolean

const COMPARISON_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'] as const
const TEXT_RANGE_OPERATORS = ['gt', 'gte', 'lt', 'lte'] as const

class FieldBits {
  constructor(
    private readonly context: FilterContext,
    private readonly fieldPath: string,
  ) {}

  none(): Uint32Array {
    return createBitSet(this.context.capacity)
  }

  present(): Uint32Array {
    return this.context.sizeIndex(this.fieldPath)?.getAllDocIdsBitset(this.context.capacity) ?? this.none()
  }

  holdingSomething(): Uint32Array {
    const empty = this.context.sizeIndex(this.fieldPath)?.queryEqBitset(0, this.context.capacity)
    return empty === undefined ? this.present() : this.without(this.present(), empty)
  }

  without(from: Uint32Array, removed: Uint32Array): Uint32Array {
    const kept = from.slice()
    bitsetAndNotInto(kept, removed)
    return kept
  }

  complement(bits: Uint32Array): Uint32Array {
    return this.without(this.context.allDocIdsBitset, bits)
  }
}

function comparisonBits(
  index: NumericFieldIndexReader | undefined,
  operator: (typeof COMPARISON_OPERATORS)[number],
  operand: unknown,
  bits: FieldBits,
  capacity: number,
): Uint32Array {
  if (operator === 'between') {
    const [low, high] = operand as [number, number]
    return index?.queryBetweenBitset(low, high, capacity) ?? bits.none()
  }
  const value = operand as number
  if (operator === 'ne') return bits.without(bits.present(), index?.queryEqBitset(value, capacity) ?? bits.none())
  if (index === undefined) return bits.none()
  if (operator === 'eq') return index.queryEqBitset(value, capacity)
  if (operator === 'gt') return index.queryGtBitset(value, capacity)
  if (operator === 'gte') return index.queryGteBitset(value, capacity)
  if (operator === 'lt') return index.queryLtBitset(value, capacity)
  return index.queryLteBitset(value, capacity)
}

function elementBits(context: FilterContext, fieldPath: string, parsed: ParsedFieldType, value: Scalar): Uint32Array {
  const { capacity } = context
  if (parsed.pattern) {
    const matches = createBitSet(capacity)
    context.matchPattern(fieldPath, 'eq', value as string, false, matches)
    return matches
  }
  if (typeof value === 'number')
    return context.numericIndex(fieldPath)?.queryEqBitset(value, capacity) ?? createBitSet(capacity)
  if (typeof value === 'boolean')
    return context.booleanIndex(fieldPath)?.queryEqBitset(value, capacity) ?? createBitSet(capacity)
  return context.enumIndex(fieldPath)?.queryEqBitset(value, capacity) ?? createBitSet(capacity)
}

function distinctScalars(values: unknown): Scalar[] {
  return [...new Set(values as Scalar[])]
}

function narrowByElements(
  fieldPath: string,
  f: Record<string, unknown>,
  parsed: ParsedFieldType,
  context: FilterContext,
  bits: FieldBits,
  narrow: Narrow,
): void {
  if (f.matchesAny !== undefined) {
    const union = bits.none()
    for (const value of distinctScalars(f.matchesAny))
      bitsetOrInto(union, elementBits(context, fieldPath, parsed, value))
    narrow(union)
  }
  if (f.containsAll !== undefined) {
    const all = bits.present()
    for (const value of distinctScalars(f.containsAll))
      bitsetAndInto(all, elementBits(context, fieldPath, parsed, value))
    narrow(all)
  }
  if (f.size !== undefined) {
    const sizes = context.sizeIndex(fieldPath)
    const comparison = f.size as Record<string, unknown>
    for (const operator of COMPARISON_OPERATORS) {
      if (comparison[operator] === undefined) continue
      narrow(comparisonBits(sizes, operator, comparison[operator], bits, context.capacity))
    }
  }
}

function narrowByValue(
  fieldPath: string,
  f: Record<string, unknown>,
  parsed: ParsedFieldType,
  context: FilterContext,
  bits: FieldBits,
  narrow: Narrow,
): void {
  const { capacity } = context
  const base = parsed.base
  if (base === 'number' || base === 'number[]') {
    const index = context.numericIndex(fieldPath)
    for (const operator of COMPARISON_OPERATORS) {
      const operand = f[operator]
      if (operand === undefined || typeof operand === 'string') continue
      if (operator === 'between' && typeof (operand as unknown[])[0] === 'string') continue
      narrow(comparisonBits(index, operator, operand, bits, capacity))
    }
    return
  }
  if (base === 'boolean' || base === 'boolean[]') {
    const index = context.booleanIndex(fieldPath)
    const equal = (value: boolean) => index?.queryEqBitset(value, capacity) ?? bits.none()
    if (typeof f.eq === 'boolean') narrow(equal(f.eq))
    if (typeof f.ne === 'boolean') narrow(bits.without(bits.present(), equal(f.ne)))
    return
  }
  if (base === 'enum' || base === 'enum[]') {
    const index = context.enumIndex(fieldPath)
    const equal = (value: string) => index?.queryEqBitset(value, capacity) ?? bits.none()
    const anyOf = (values: string[]) => index?.queryInBitset(values, capacity) ?? bits.none()
    if (typeof f.eq === 'string') narrow(equal(f.eq))
    if (typeof f.ne === 'string') narrow(bits.without(bits.present(), equal(f.ne)))
    if (Array.isArray(f.in)) narrow(anyOf(f.in as string[]))
    if (Array.isArray(f.nin)) narrow(bits.without(bits.present(), anyOf(f.nin as string[])))
    if (typeof f.startsWith === 'string') narrow(index?.queryPrefixBitset(f.startsWith, capacity) ?? bits.none())
    if (typeof f.endsWith === 'string') narrow(index?.querySuffixBitset(f.endsWith, capacity) ?? bits.none())
  }
}

function narrowByLocation(fieldPath: string, f: Record<string, unknown>, context: FilterContext, narrow: Narrow): void {
  const index = context.geoIndex(fieldPath)
  if (f.radius !== undefined) {
    const circle = (f as GeoRadiusFilter).radius
    const found = index?.radiusQuery(
      circle.lat,
      circle.lon,
      circle.distance * GEO_UNIT_METRES[circle.unit],
      circle.inside ?? true,
      circle.highPrecision ?? false,
    )
    narrow(bitsetFromSet(found ?? new Set(), context.capacity))
  }
  if (f.polygon !== undefined) {
    const polygon = (f as GeoPolygonFilter).polygon
    narrow(bitsetFromSet(index?.polygonQuery(polygon.points, polygon.inside ?? true) ?? new Set(), context.capacity))
  }
}

function narrowByPresence(f: Record<string, unknown>, bits: FieldBits, narrow: Narrow): void {
  if (typeof f.exists === 'boolean') narrow(f.exists ? bits.present() : bits.complement(bits.present()))
  if (typeof f.notExists === 'boolean') narrow(f.notExists ? bits.complement(bits.present()) : bits.present())
  if (typeof f.isNotEmpty === 'boolean') {
    const holding = bits.holdingSomething()
    narrow(f.isNotEmpty ? holding : bits.complement(holding))
  }
  if (typeof f.isEmpty === 'boolean') {
    const holding = bits.holdingSomething()
    narrow(f.isEmpty ? bits.complement(holding) : holding)
  }
}

function textBoundsOf(operator: (typeof TEXT_RANGE_OPERATORS)[number], bound: string): TextRangeBounds {
  if (operator === 'gt' || operator === 'gte') {
    return { lower: bound, upper: null, lowerInclusive: operator === 'gte', upperInclusive: false }
  }
  return { lower: null, upper: bound, upperInclusive: operator === 'lte', lowerInclusive: false }
}

function narrowByTextRange(
  fieldPath: string,
  f: Record<string, unknown>,
  context: FilterContext,
  narrow: Narrow,
): void {
  for (const operator of TEXT_RANGE_OPERATORS) {
    const bound = f[operator]
    if (typeof bound === 'string') narrow(context.textRangeBitset(fieldPath, textBoundsOf(operator, bound)))
  }
  if (!Array.isArray(f.between)) return
  const [low, high] = f.between as [unknown, unknown]
  if (typeof low !== 'string' || typeof high !== 'string') return
  narrow(context.textRangeBitset(fieldPath, { lower: low, lowerInclusive: true, upper: high, upperInclusive: true }))
}

export function narrowByFieldTests(
  fieldPath: string,
  f: Record<string, unknown>,
  parsed: ParsedFieldType,
  context: FilterContext,
  narrow: Narrow,
): void {
  const bits = new FieldBits(context, fieldPath)
  narrowByPresence(f, bits, narrow)
  narrowByLocation(fieldPath, f, context, narrow)
  narrowByTextRange(fieldPath, f, context, narrow)
  if (parsed.pattern) {
    const patternBits: Uint32Array[] = []
    evaluatePatternTests(fieldPath, f, context, patternBits)
    for (const matched of patternBits) narrow(matched)
  } else {
    narrowByValue(fieldPath, f, parsed, context, bits, narrow)
  }
  narrowByElements(fieldPath, f, parsed, context, bits, narrow)
}
