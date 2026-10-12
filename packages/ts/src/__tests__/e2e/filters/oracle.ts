import type { AnyDocument } from '../../../types/schema'
import { codePointsOf } from '../pattern-search/oracle'

const EARTH_RADIUS_METRES = 6_371_008.8
const METRES_PER_UNIT = { km: 1_000, mi: 1_609.344, m: 1 } as const
const SORT_VALUE_CODE_POINTS = 512

export type Verdict = boolean | null

export function valueAt(document: AnyDocument, path: string): unknown {
  let current: unknown = document
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const a =
    Math.sin((radians(lat2) - radians(lat1)) / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin((radians(lon2) - radians(lon1)) / 2) ** 2
  return EARTH_RADIUS_METRES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

interface Point {
  lat: number
  lon: number
}

function crossesAntimeridian(polygon: readonly Point[]): boolean {
  const longitudes = polygon.map(point => point.lon)
  let twiceArea = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    twiceArea += polygon[j].lon * polygon[i].lat - polygon[i].lon * polygon[j].lat
  }
  return Math.max(...longitudes) - Math.min(...longitudes) >= 180 && twiceArea < 0
}

export function insidePolygon(point: Point, polygon: readonly Point[]): boolean {
  const shift = crossesAntimeridian(polygon) ? (lon: number) => (lon < 0 ? lon + 360 : lon) : (lon: number) => lon
  const ring = polygon.map(vertex => ({ lat: vertex.lat, lon: shift(vertex.lon) }))
  const lon = shift(point.lon)
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (ring[i].lon > lon !== ring[j].lon > lon) {
      const slope = (ring[j].lat - ring[i].lat) / (ring[j].lon - ring[i].lon)
      if (point.lat < ring[i].lat + slope * (lon - ring[i].lon)) inside = !inside
    }
  }
  return inside
}

function compareSortStrings(left: string, right: string): number {
  const leftRaw = codePointsOf(left, false).slice(0, SORT_VALUE_CODE_POINTS)
  const rightRaw = codePointsOf(right, false).slice(0, SORT_VALUE_CODE_POINTS)
  const compare = (a: number[], b: number[]) => {
    for (let at = 0; at < Math.min(a.length, b.length); at++) if (a[at] !== b[at]) return a[at] - b[at]
    return a.length - b.length
  }
  const folded = compare(
    codePointsOf(String.fromCodePoint(...leftRaw), true),
    codePointsOf(String.fromCodePoint(...rightRaw), true),
  )
  return folded !== 0 ? folded : compare(leftRaw, rightRaw)
}

function compareValues(value: unknown, bound: unknown): number | null {
  if (typeof value === 'number' && typeof bound === 'number') return value - bound
  if (typeof value === 'string' && typeof bound === 'string') return compareSortStrings(value, bound)
  return null
}

function scalarVerdict(value: unknown, operator: string, operand: unknown): Verdict {
  if (value === undefined || value === null) return null
  const order = compareValues(value, operand)
  switch (operator) {
    case 'eq':
      return value === operand
    case 'ne':
      return value !== operand
    case 'gt':
      return order === null ? null : order > 0
    case 'gte':
      return order === null ? null : order >= 0
    case 'lt':
      return order === null ? null : order < 0
    case 'lte':
      return order === null ? null : order <= 0
    case 'between': {
      const [low, high] = operand as [unknown, unknown]
      const above = compareValues(value, low)
      const below = compareValues(value, high)
      return above === null || below === null ? null : above >= 0 && below <= 0
    }
    case 'in':
      return (operand as unknown[]).includes(value)
    case 'nin':
      return !(operand as unknown[]).includes(value)
    case 'startsWith':
      return typeof value === 'string' && value.startsWith(operand as string)
    case 'endsWith':
      return typeof value === 'string' && value.endsWith(operand as string)
    default:
      return null
  }
}

function listVerdict(values: unknown[], operator: string, operand: unknown): Verdict {
  switch (operator) {
    case 'containsAll':
      return (operand as unknown[]).every(wanted => values.includes(wanted))
    case 'matchesAny':
      return (operand as unknown[]).some(wanted => values.includes(wanted))
    case 'ne':
    case 'nin':
      if (values.length === 0) return null
      return values.every(value => scalarVerdict(value, operator, operand) === true)
    case 'eq':
    case 'in':
    case 'startsWith':
    case 'endsWith':
      return values.some(value => scalarVerdict(value, operator, operand) === true)
    default:
      return null
  }
}

function sizeVerdict(values: unknown[], comparison: Record<string, unknown>): Verdict {
  let passes = true
  for (const [operator, operand] of Object.entries(comparison)) {
    const verdict = scalarVerdict(values.length, operator, operand)
    if (verdict === null) return null
    passes &&= verdict
  }
  return passes
}

function geoVerdict(value: unknown, operator: string, operand: Record<string, unknown>): Verdict {
  if (value === undefined || value === null) return null
  const point = value as Point
  const inside = operand.inside !== false
  if (operator === 'radius') {
    const metres = (operand.distance as number) * METRES_PER_UNIT[operand.unit as keyof typeof METRES_PER_UNIT]
    const within = haversineMetres(operand.lat as number, operand.lon as number, point.lat, point.lon) <= metres
    return within === inside
  }
  return insidePolygon(point, operand.points as Point[]) === inside
}

function presenceVerdict(value: unknown, operator: string, operand: unknown): Verdict {
  if (value === null) return null
  const present = value !== undefined
  const empty = value === '' || (Array.isArray(value) && value.length === 0)
  const wanted = operand === true
  switch (operator) {
    case 'exists':
      return present === wanted
    case 'notExists':
      return !present === wanted
    case 'isEmpty':
      return present ? empty === wanted : null
    case 'isNotEmpty':
      return present ? !empty === wanted : null
    default:
      return null
  }
}

const PRESENCE = new Set(['exists', 'notExists', 'isEmpty', 'isNotEmpty'])

export function fieldVerdict(document: AnyDocument, field: string, filter: Record<string, unknown>): Verdict {
  const value = valueAt(document, field)
  let passes = true
  for (const [operator, operand] of Object.entries(filter)) {
    let verdict: Verdict
    if (PRESENCE.has(operator)) verdict = presenceVerdict(value, operator, operand)
    else if (operator === 'radius' || operator === 'polygon')
      verdict = geoVerdict(value, operator, operand as Record<string, unknown>)
    else if (operator === 'size')
      verdict = Array.isArray(value) ? sizeVerdict(value, operand as Record<string, unknown>) : null
    else if (Array.isArray(value)) verdict = listVerdict(value, operator, operand)
    else verdict = scalarVerdict(value, operator, operand)
    if (verdict === null) return null
    passes &&= verdict
  }
  return passes
}
