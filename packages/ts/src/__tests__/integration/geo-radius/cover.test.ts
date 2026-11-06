import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import { indexOfPoints, matchedIds, wronglyDecided } from './fixtures'
import {
  DEGREES,
  EARTH_RADIUS_METRES,
  haversineMetres,
  type Point,
  travel,
  vincentyMetres,
  wrapLongitude,
} from './oracle'

const TEST_TIMEOUT_MS = 300_000
const AXIS_CELLS = 2 ** 26
const LATITUDE_CELL_DEGREES = 180 / AXIS_CELLS
const LONGITUDE_CELL_DEGREES = 360 / AXIS_CELLS
const BESIDE_BOUNDARY_DEGREES = 1e-11
const FINE_ROW = 2 ** 25 + 1_234_567
const FINE_COLUMN = 2 ** 25 + 7_654_321

function latitudeBoundary(row: number): number {
  return -90 + row * LATITUDE_CELL_DEGREES
}

function longitudeBoundary(column: number): number {
  return -180 + column * LONGITUDE_CELL_DEGREES
}

const CENTRES: Point[] = [
  { lat: 0, lon: 0 },
  { lat: 45, lon: -90 },
  { lat: latitudeBoundary(FINE_ROW), lon: longitudeBoundary(FINE_COLUMN) },
  {
    lat: latitudeBoundary(FINE_ROW) + BESIDE_BOUNDARY_DEGREES,
    lon: longitudeBoundary(FINE_COLUMN) - BESIDE_BOUNDARY_DEGREES,
  },
  { lat: -latitudeBoundary(FINE_ROW + 3), lon: longitudeBoundary(AXIS_CELLS - 3) },
  { lat: 89.99, lon: longitudeBoundary(FINE_COLUMN) },
  { lat: 89.9999, lon: 0 },
  { lat: -89.9999, lon: longitudeBoundary(5) },
  { lat: -89.99 - BESIDE_BOUNDARY_DEGREES, lon: 120 },
]
const RADII_METRES = [1, 10, 100, 1_000]
const RING_BEARINGS = 64
const RING_FACTORS = [-1e-6, -1e-9, 0, 1e-9, 1e-6]
const WIDEST_FACTORS = [-1e-6, -1e-9, -1e-12, 0, 1e-12, 1e-9, 1e-6]
const GRID_LINES = 13
const GRID_REACH = 1.2

function widestPoints(centre: Point, angle: number): Point[] {
  const phi = centre.lat * DEGREES
  const ratio = Math.sin(phi) / Math.cos(angle)
  const spreadRatio = Math.sin(angle) / Math.cos(phi)
  if (Math.abs(ratio) > 1 || spreadRatio > 1) return []
  const lat = Math.asin(ratio) / DEGREES
  const spread = Math.asin(spreadRatio) / DEGREES
  const points: Point[] = []
  for (const factor of WIDEST_FACTORS) {
    points.push({ lat, lon: wrapLongitude(centre.lon + spread * (1 + factor)) })
    points.push({ lat, lon: wrapLongitude(centre.lon - spread * (1 + factor)) })
  }
  return points
}

function snappedLines(middle: number, reach: number, cell: number, lowest: number, highest: number): number[] {
  const lines: number[] = []
  for (let line = 0; line < GRID_LINES; line++) {
    const value = middle - reach + (2 * reach * line) / (GRID_LINES - 1)
    const boundary = lowest + Math.round((value - lowest) / cell) * cell
    for (const offset of [-BESIDE_BOUNDARY_DEGREES, 0, BESIDE_BOUNDARY_DEGREES]) {
      const placed = boundary + offset
      if (placed >= lowest && placed <= highest) lines.push(placed)
    }
  }
  return lines
}

function gridPoints(centre: Point, angle: number): Point[] {
  const latitudeReach = (angle / DEGREES) * GRID_REACH
  const longitudeReach = Math.min(180, latitudeReach / Math.max(Math.cos(centre.lat * DEGREES), 1e-12))
  const points: Point[] = []
  for (const lat of snappedLines(centre.lat, latitudeReach, LATITUDE_CELL_DEGREES, -90, 90)) {
    for (const lon of snappedLines(centre.lon, longitudeReach, LONGITUDE_CELL_DEGREES, -540, 540)) {
      points.push({ lat, lon: wrapLongitude(lon) })
    }
  }
  return points
}

function coverPoints(): Point[] {
  const points: Point[] = []
  for (const centre of CENTRES) {
    for (const radius of RADII_METRES) {
      const angle = radius / EARTH_RADIUS_METRES
      points.push(...widestPoints(centre, angle), ...gridPoints(centre, angle))
      for (let turn = 0; turn < RING_BEARINGS; turn++) {
        const bearing = (2 * Math.PI * turn) / RING_BEARINGS
        for (const factor of RING_FACTORS) points.push(travel(centre, bearing, angle * (1 + factor)))
      }
    }
  }
  return points
}

describe('a radius filter finds every point that a scan of all documents finds', () => {
  let narsil: Narsil
  const points = coverPoints()

  beforeAll(async () => {
    narsil = await indexOfPoints(points)
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await narsil.shutdown()
  })

  for (const highPrecision of [false, true]) {
    const formula = highPrecision ? 'Vincenty' : 'Haversine'
    const distance = highPrecision ? vincentyMetres : haversineMetres
    it(
      `matches the scan for small circles on cell edges and near the poles under ${formula}`,
      async () => {
        for (const centre of CENTRES) {
          for (const radius of RADII_METRES) {
            const found = await matchedIds(narsil, centre, radius, highPrecision)
            const wrong = wronglyDecided(points, found, point => distance(centre, point) <= radius)
            expect(wrong, `${formula} ${JSON.stringify(centre)} ${radius} m`).toEqual([])
          }
        }
      },
      TEST_TIMEOUT_MS,
    )
  }
})
