import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import { indexOfPoints, matchedIds, wronglyDecided } from './fixtures'
import { EARTH_RADIUS_METRES, haversineMetres, type Point, travel, vincentyMetres, wrapLongitude } from './oracle'

const BISECTION_STEPS = 80
const TEST_TIMEOUT_MS = 300_000
const HALF_CIRCUMFERENCE_METRES = Math.PI * EARTH_RADIUS_METRES

const CENTRES = [
  { lat: 0, lon: 0 },
  { lat: 45, lon: 10 },
  { lat: -33.9, lon: 151.2 },
  { lat: 80, lon: -40 },
  { lat: 90, lon: 0 },
  { lat: -90, lon: 0 },
  { lat: 89.9999999, lon: 10 },
  { lat: -89.9999999, lon: -170 },
  { lat: 89.9, lon: 0 },
  { lat: -89.99, lon: 120 },
  { lat: 0, lon: 180 },
  { lat: 0, lon: -180 },
  { lat: 45, lon: 179.9999 },
  { lat: -30, lon: -179.99 },
  { lat: 10, lon: 179.99 },
]
const RADII_METRES = [
  1,
  10,
  1_000,
  60_000,
  400_000,
  2_500_000,
  9_000_000,
  18_000_000,
  19_100_000,
  19_200_000,
  20_000_000,
  HALF_CIRCUMFERENCE_METRES - 1,
  HALF_CIRCUMFERENCE_METRES,
  HALF_CIRCUMFERENCE_METRES + 1,
  25_000_000,
]
const BEARINGS = 8
const EDGE_FACTORS = [-1e-5, -1e-6, -1e-9, -1e-12, -1e-14, 0, 1e-14, 1e-12, 1e-9, 1e-6, 1e-5]
const ANTIPODE_OFFSETS_RADIANS = [1e-12, 1e-9, 1e-6, 1e-3]
const ANTIPODE_BEARINGS = 4

function vincentyEdgeAngle(centre: Point, bearing: number, radius: number): number {
  let near = 0
  let far = (radius / EARTH_RADIUS_METRES) * 1.02
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const middle = (near + far) / 2
    if (vincentyMetres(centre, travel(centre, bearing, middle)) <= radius) near = middle
    else far = middle
  }
  return near
}

function edgePoints(): Point[] {
  const points: Point[] = []
  for (const centre of CENTRES) {
    for (const radius of RADII_METRES) {
      for (let turn = 0; turn < BEARINGS; turn++) {
        const bearing = (2 * Math.PI * turn) / BEARINGS + 0.1
        const sphereEdge = radius / EARTH_RADIUS_METRES
        const ellipsoidEdge = vincentyEdgeAngle(centre, bearing, radius)
        for (const factor of EDGE_FACTORS) {
          points.push(travel(centre, bearing, sphereEdge * (1 + factor)))
          points.push(travel(centre, bearing, ellipsoidEdge * (1 + factor)))
        }
      }
    }
    const antipode = { lat: -centre.lat, lon: wrapLongitude(centre.lon + 180) }
    points.push(antipode)
    for (const offset of ANTIPODE_OFFSETS_RADIANS) {
      for (let turn = 0; turn < ANTIPODE_BEARINGS; turn++) {
        points.push(travel(antipode, (2 * Math.PI * turn) / ANTIPODE_BEARINGS + 0.3, offset))
      }
    }
  }
  return points
}

describe('a radius filter decides points at the edge of its circle', () => {
  let narsil: Narsil
  const points = edgePoints()

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
      `matches exactly the points within the radius under ${formula}`,
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
