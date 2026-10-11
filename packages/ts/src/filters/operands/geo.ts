import { MAX_LATITUDE_DEGREES, MAX_LONGITUDE_DEGREES } from '../../geo/constants'
import { isLatitude, isLongitude } from '../../geo/coordinates'
import { requirePolygonRing } from '../../geo/polygon'
import { GEO_UNIT_METRES } from '../constants'
import { invalid, isFiniteNumber, isObjectRecord, requireListLength } from './checks'

function requireFlag(fieldPath: string, operator: string, flag: string, value: unknown): void {
  if (value === undefined || typeof value === 'boolean') return
  invalid(`"${operator}.${flag}" on field "${fieldPath}" must be true or false`, fieldPath, operator)
}

function requireRadius(fieldPath: string, radius: unknown): void {
  const circle = radius as Record<string, unknown> | null
  if (circle === null || typeof circle !== 'object') {
    invalid(`"radius" on field "${fieldPath}" must be an object`, fieldPath, 'radius')
  }
  for (const key of ['lat', 'lon', 'distance']) {
    if (!isFiniteNumber(circle[key])) {
      invalid(`"radius.${key}" on field "${fieldPath}" must be a finite number`, fieldPath, 'radius')
    }
  }
  if (typeof circle.unit !== 'string' || !Object.hasOwn(GEO_UNIT_METRES, circle.unit)) {
    invalid(
      `"radius.unit" on field "${fieldPath}" must be one of ${Object.keys(GEO_UNIT_METRES).join(', ')}, and this filter sets ${String(circle.unit)}`,
      fieldPath,
      'radius',
    )
  }
  requireFlag(fieldPath, 'radius', 'inside', circle.inside)
  requireFlag(fieldPath, 'radius', 'highPrecision', circle.highPrecision)
  if ((circle.distance as number) < 0) {
    invalid(
      `"radius.distance" on field "${fieldPath}" must be zero or more, and this filter sets ${String(circle.distance)}`,
      fieldPath,
      'radius',
    )
  }
  if (!isLatitude(circle.lat as number)) {
    invalid(
      `"radius.lat" on field "${fieldPath}" must be from -${MAX_LATITUDE_DEGREES} to ${MAX_LATITUDE_DEGREES}, and this filter sets ${String(circle.lat)}`,
      fieldPath,
      'radius',
    )
  }
  if (!isLongitude(circle.lon as number)) {
    invalid(
      `"radius.lon" on field "${fieldPath}" must be from -${MAX_LONGITUDE_DEGREES} to ${MAX_LONGITUDE_DEGREES}, and this filter sets ${String(circle.lon)}`,
      fieldPath,
      'radius',
    )
  }
}

export function requireGeoOperands(fieldPath: string, filter: Record<string, unknown>): void {
  if (filter.radius !== undefined) requireRadius(fieldPath, filter.radius)
  if (filter.polygon === undefined) return
  if (!isObjectRecord(filter.polygon)) {
    invalid(`"polygon" on field "${fieldPath}" must be an object`, fieldPath, 'polygon')
  }
  requireFlag(fieldPath, 'polygon', 'inside', filter.polygon.inside)
  const points = filter.polygon.points
  if (Array.isArray(points)) requireListLength(fieldPath, 'polygon', points)
  requirePolygonRing(points)
}
