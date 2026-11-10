import { bitsetAndInto, bitsetIsEmpty, createBitSet } from '../../core/bitset'
import * as L from '../../core/filters/layout'
import { requirePatternSearch } from '../../core/pattern-index/registry'
import type { ParsedFieldType } from '../../schema/validator/field-type'
import type { GeoPolygonFilter, GeoRadiusFilter } from '../../types/filters'
import { GEO_UNIT_METRES } from '../constants'
import type { FilterBuilder } from './builder'

const COMPARISONS = [
  ['eq', L.FILTER_EQ],
  ['ne', L.FILTER_EQ],
  ['gt', L.FILTER_GT],
  ['gte', L.FILTER_GTE],
  ['lt', L.FILTER_LT],
  ['lte', L.FILTER_LTE],
  ['between', L.FILTER_BETWEEN],
] as const

function holding(builder: FilterBuilder, path: string, field: number): void {
  builder.emit(L.FILTER_PRESENT, field)
  if (builder.context.sizeIndex(path) === undefined) return
  builder.test(builder.field(path, true), L.FILTER_EQ, 0)
  builder.emit(L.FILTER_ANDNOT)
}

export function fieldPlan(
  builder: FilterBuilder,
  path: string,
  filter: Record<string, unknown>,
  parsed: ParsedFieldType,
): void {
  const field = builder.field(path)
  let count = 0
  function append(): void {
    if (count++ !== 0) builder.emit(L.FILTER_AND, 0, 0, 2)
  }
  function comparison(
    operator: string,
    opcode: number,
    value: number | boolean | string | readonly number[],
    target = field,
  ): void {
    if (operator === 'ne' || operator === 'nin') builder.emit(L.FILTER_PRESENT, field)
    builder.test(target, opcode, value)
    if (operator === 'ne' || operator === 'nin') builder.emit(L.FILTER_ANDNOT)
    append()
  }
  for (const operator of ['exists', 'notExists', 'isNotEmpty', 'isEmpty']) {
    const value = filter[operator]
    if (typeof value !== 'boolean') continue
    if (operator === 'exists' || operator === 'notExists') builder.emit(L.FILTER_PRESENT, field)
    else holding(builder, path, field)
    if (value === (operator === 'notExists' || operator === 'isEmpty')) builder.emit(L.FILTER_NOT)
    append()
  }
  if (filter.radius !== undefined) {
    const radius = (filter as unknown as GeoRadiusFilter).radius
    if (radius.inside === false) builder.emit(L.FILTER_PRESENT, field)
    builder.test(field, L.FILTER_RADIUS, [
      radius.lat,
      radius.lon,
      radius.distance * GEO_UNIT_METRES[radius.unit],
      Number(radius.highPrecision ?? false),
    ])
    if (radius.inside === false) builder.emit(L.FILTER_ANDNOT)
    append()
  }
  if (filter.polygon !== undefined) {
    const polygon = (filter as unknown as GeoPolygonFilter).polygon
    if (polygon.inside === false) builder.emit(L.FILTER_PRESENT, field)
    const numbers = [polygon.points.length]
    for (const point of polygon.points) numbers.push(point.lat, point.lon)
    builder.test(field, L.FILTER_POLYGON, numbers)
    if (polygon.inside === false) builder.emit(L.FILTER_ANDNOT)
    append()
  }
  for (const [operator, opcode] of COMPARISONS) {
    if (operator === 'eq' || operator === 'ne') continue
    const value = filter[operator]
    if (typeof value === 'string') {
      const lower = operator === 'gt' || operator === 'gte'
      builder.bitset(
        builder.context.textRangeBitset(path, {
          lower: lower ? value : null,
          upper: lower ? null : value,
          lowerInclusive: operator === 'gte',
          upperInclusive: operator === 'lte',
        }),
      )
      append()
    } else if (operator === 'between' && Array.isArray(value) && typeof value[0] === 'string') {
      builder.bitset(
        builder.context.textRangeBitset(path, {
          lower: value[0],
          upper: value[1] as string,
          lowerInclusive: true,
          upperInclusive: true,
        }),
      )
      append()
    } else if (value !== undefined && !parsed.pattern) comparison(operator, opcode, value as number | number[])
  }
  if (parsed.pattern) {
    const matches: Uint32Array[] = []
    requirePatternSearch(path).evaluateTests(path, filter, builder.context, matches)
    for (const bits of matches) {
      builder.bitset(bits)
      append()
    }
  } else {
    for (const operator of ['eq', 'ne']) {
      const value = filter[operator]
      if (value !== undefined) comparison(operator, L.FILTER_EQ, value as number | boolean | string)
    }
    for (const [operator, opcode] of [
      ['in', L.FILTER_ANY],
      ['nin', L.FILTER_ANY],
      ['startsWith', L.FILTER_PREFIX],
      ['endsWith', L.FILTER_SUFFIX],
    ] as const) {
      const value = filter[operator]
      if (value === undefined) continue
      if (operator === 'nin') builder.emit(L.FILTER_PRESENT, field)
      builder.test(field, opcode, value as string | string[])
      if (operator === 'nin') builder.emit(L.FILTER_ANDNOT)
      append()
    }
  }
  for (const [operator, opcode] of [
    ['matchesAny', L.FILTER_ANY],
    ['containsAll', L.FILTER_ALL],
  ] as const) {
    const value = filter[operator]
    if (!Array.isArray(value)) continue
    if (parsed.pattern) {
      const bits =
        opcode === L.FILTER_ALL ? builder.context.presentBitset(path).slice() : createBitSet(builder.context.capacity)
      for (const item of new Set(value as string[])) {
        if (opcode === L.FILTER_ALL && bitsetIsEmpty(bits)) break
        const into = opcode === L.FILTER_ALL ? createBitSet(builder.context.capacity) : bits
        builder.context.matchPattern(path, 'eq', item, false, 0, into)
        if (opcode === L.FILTER_ALL) bitsetAndInto(bits, into)
      }
      builder.bitset(bits)
    } else {
      if (opcode === L.FILTER_ALL) builder.emit(L.FILTER_PRESENT, field)
      builder.test(field, opcode, [...new Set(value as Array<string | number | boolean>)])
      if (opcode === L.FILTER_ALL) builder.emit(L.FILTER_AND, 0, 0, 2)
    }
    append()
  }
  if (filter.size !== undefined) {
    const size = filter.size as Record<string, number | number[] | undefined>
    for (const [operator, opcode] of COMPARISONS) {
      const value = size[operator]
      if (value !== undefined) comparison(operator, opcode, value, builder.field(path, true))
    }
  }
  if (count === 0) builder.bitset(builder.context.allDocIdsBitset)
}
