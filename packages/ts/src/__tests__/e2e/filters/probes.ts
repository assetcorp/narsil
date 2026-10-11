import type { FilterExpression } from '../../../types/filters'
import { seededRandom } from '../../filters/pattern/random-corpus'
import { BRANDS, CATEGORIES, CITIES, COLOURS, NAMES, PRICES, TAGS } from './corpus'

export interface FieldProbe {
  field: string
  filter: Record<string, unknown>
}

type Random = () => number

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]
}

function some<T>(random: Random, items: readonly T[]): T[] {
  return items.filter(() => random() < 0.4)
}

const NUMBER_EDGES = [...PRICES, -1e300, 1e300, 5, 0.1]
const RATINGS = [0, 2.5, 3, 4.9, 5]
const PRESENCE_OPERATORS = ['exists', 'notExists', 'isEmpty', 'isNotEmpty'] as const

function numberProbe(random: Random, field: string, values: readonly number[]): FieldProbe {
  const operator = pick(random, ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'] as const)
  if (operator === 'between') {
    const bounds = [pick(random, values), pick(random, values)].sort((a, b) => a - b)
    return { field, filter: { between: bounds } }
  }
  return { field, filter: { [operator]: pick(random, values) } }
}

function textProbe(random: Random, field: string, values: readonly string[], ranges: boolean): FieldProbe {
  const operators = [
    'eq',
    'ne',
    'in',
    'nin',
    'startsWith',
    'endsWith',
    ...(ranges ? ['gt', 'gte', 'lt', 'lte', 'between'] : []),
  ]
  const operator = pick(random, operators)
  const value = pick(random, values)
  if (operator === 'in' || operator === 'nin') return { field, filter: { [operator]: some(random, values) } }
  if (operator === 'startsWith') return { field, filter: { startsWith: value.slice(0, 1 + Math.floor(random() * 3)) } }
  if (operator === 'endsWith') return { field, filter: { endsWith: value.slice(-1 - Math.floor(random() * 3)) } }
  if (operator === 'between') {
    const other = pick(random, values)
    return { field, filter: { between: [value, other].sort() } }
  }
  return { field, filter: { [operator]: value } }
}

function listProbe(random: Random, field: string, values: readonly (string | number | boolean)[]): FieldProbe {
  const operator = pick(random, ['containsAll', 'matchesAny', 'size', 'eq', 'ne'] as const)
  if (operator === 'size')
    return { field, filter: { size: { [pick(random, ['eq', 'gte', 'lt'])]: Math.floor(random() * 4) } } }
  if (operator === 'eq' || operator === 'ne') return { field, filter: { [operator]: pick(random, values) } }
  return { field, filter: { [operator]: some(random, values) } }
}

function geoProbe(random: Random): FieldProbe {
  const city = pick(random, CITIES)
  const inside = random() < 0.7
  if (random() < 0.5) {
    const unit = pick(random, ['km', 'mi', 'm'] as const)
    const distance = { km: 20, mi: 12, m: 20_000 }[unit] * (1 + Math.floor(random() * 300))
    return { field: 'location', filter: { radius: { lat: city.lat, lon: city.lon, distance, unit, inside } } }
  }
  const span = 1 + random() * 20
  const points = [
    { lat: city.lat - span, lon: city.lon - span },
    { lat: city.lat - span, lon: city.lon + span },
    { lat: city.lat + span, lon: city.lon + span },
    { lat: city.lat + span, lon: city.lon - span },
  ].map(point => ({ lat: Math.max(-90, Math.min(90, point.lat)), lon: ((point.lon + 540) % 360) - 180 }))
  return { field: 'location', filter: { polygon: { points, inside } } }
}

export function fieldProbe(random: Random): FieldProbe {
  const kind = Math.floor(random() * 13)
  switch (kind) {
    case 0:
      return numberProbe(random, 'price', NUMBER_EDGES)
    case 1:
      return numberProbe(random, 'rating', RATINGS)
    case 2:
      return numberProbe(random, 'dims.width', NUMBER_EDGES)
    case 3:
      return { field: 'inStock', filter: { [pick(random, ['eq', 'ne'])]: random() < 0.5 } }
    case 4:
      return textProbe(random, 'category', CATEGORIES, false)
    case 5:
      return textProbe(random, 'brand', BRANDS, false)
    case 6:
      return textProbe(random, 'name', NAMES, true)
    case 7:
      return listProbe(random, 'tags', TAGS)
    case 8:
      return listProbe(random, 'sizes', [1, 2, 3, 2.5, -1, 0])
    case 9:
      return listProbe(random, 'colours', COLOURS)
    case 10:
      return listProbe(random, 'flags', [true, false])
    case 11:
      return geoProbe(random)
    default: {
      const field = pick(random, ['price', 'tags', 'name', 'brand', 'location', 'dims.label', 'colours'])
      return { field, filter: { [pick(random, PRESENCE_OPERATORS)]: random() < 0.8 } }
    }
  }
}

export function fieldProbes(count: number, seed: number): FieldProbe[] {
  const random = seededRandom(seed)
  return Array.from({ length: count }, () => fieldProbe(random))
}

export function randomExpression(random: Random, depth: number): FilterExpression {
  const roll = random()
  if (depth === 0 || roll < 0.4) {
    const { field, filter } = fieldProbe(random)
    return { fields: { [field]: filter } } as FilterExpression
  }
  if (roll < 0.6) return { not: randomExpression(random, depth - 1) }
  const children = Array.from({ length: 2 + Math.floor(random() * 2) }, () => randomExpression(random, depth - 1))
  return roll < 0.8 ? { and: children } : { or: children }
}
