import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

const INDEX = 'places'
const EARTH_RADIUS_METRES = 6_371_008.8
const DEGREES = Math.PI / 180
const WGS84_A = 6_378_137.0
const WGS84_F = 1 / 298.257223563
const WGS84_B = WGS84_A * (1 - WGS84_F)
const VINCENTY_ITERATIONS = 200
const VINCENTY_CONVERGED = 1e-12
const BISECTION_STEPS = 80
const PAGE_SIZE = 10_000
const TEST_TIMEOUT_MS = 120_000

const CENTRES = [
  { lat: 0, lon: 0 },
  { lat: 45, lon: 10 },
  { lat: -33.9, lon: 151.2 },
  { lat: 80, lon: -40 },
  { lat: 89.9, lon: 0 },
  { lat: -89.99, lon: 120 },
  { lat: 10, lon: 179.99 },
]
const RADII_METRES = [10, 1_000, 60_000, 400_000, 2_500_000, 9_000_000, 18_000_000]
const BEARINGS = 12
const EDGE_FACTORS = [-1e-5, -1e-6, -1e-9, -1e-12, -1e-14, 0, 1e-14, 1e-12, 1e-9, 1e-6, 1e-5]
const VINCENTY_EDGE_LIMIT_METRES = 2_500_000

interface Point {
  lat: number
  lon: number
}

function haversineMetres(from: Point, to: Point): number {
  const deltaPhi = (to.lat - from.lat) * DEGREES
  const deltaLambda = (to.lon - from.lon) * DEGREES
  const halfDeltaPhi = Math.sin(deltaPhi / 2)
  const halfDeltaLambda = Math.sin(deltaLambda / 2)
  const a =
    halfDeltaPhi * halfDeltaPhi +
    Math.cos(from.lat * DEGREES) * Math.cos(to.lat * DEGREES) * halfDeltaLambda * halfDeltaLambda
  return EARTH_RADIUS_METRES * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

function vincentyMetres(from: Point, to: Point): number {
  const reducedFrom = Math.atan((1 - WGS84_F) * Math.tan(from.lat * DEGREES))
  const reducedTo = Math.atan((1 - WGS84_F) * Math.tan(to.lat * DEGREES))
  const sinU1 = Math.sin(reducedFrom)
  const cosU1 = Math.cos(reducedFrom)
  const sinU2 = Math.sin(reducedTo)
  const cosU2 = Math.cos(reducedTo)
  const longitudeGap = (to.lon - from.lon) * DEGREES
  let lambda = longitudeGap
  let previous = 0
  let sinSigma = 0
  let cosSigma = 0
  let sigma = 0
  let cos2Alpha = 0
  let cos2SigmaM = 0
  let left = VINCENTY_ITERATIONS
  do {
    const sinLambda = Math.sin(lambda)
    const cosLambda = Math.cos(lambda)
    const east = cosU2 * sinLambda
    const north = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda
    sinSigma = Math.sqrt(east * east + north * north)
    if (sinSigma === 0) return 0
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma
    cos2Alpha = 1 - sinAlpha * sinAlpha
    cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha
    const c = (WGS84_F / 16) * cos2Alpha * (4 + WGS84_F * (4 - 3 * cos2Alpha))
    previous = lambda
    lambda =
      longitudeGap +
      (1 - c) *
        WGS84_F *
        sinAlpha *
        (sigma + c * sinSigma * (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
  } while (Math.abs(lambda - previous) > VINCENTY_CONVERGED && --left > 0)
  if (left === 0) return haversineMetres(from, to)
  const uSquare = (cos2Alpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B)
  const bigA = 1 + (uSquare / 16384) * (4096 + uSquare * (-768 + uSquare * (320 - 175 * uSquare)))
  const bigB = (uSquare / 1024) * (256 + uSquare * (-128 + uSquare * (74 - 47 * uSquare)))
  const deltaSigma =
    bigB *
    sinSigma *
    (cos2SigmaM +
      (bigB / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
  return WGS84_B * bigA * (sigma - deltaSigma)
}

function wrapLongitude(lon: number): number {
  if (lon > 180) return lon - 360
  if (lon < -180) return lon + 360
  return lon
}

function travel(from: Point, bearing: number, angle: number): Point {
  const phi = from.lat * DEGREES
  const lat = Math.asin(Math.sin(phi) * Math.cos(angle) + Math.cos(phi) * Math.sin(angle) * Math.cos(bearing))
  const lon =
    from.lon * DEGREES +
    Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(phi), Math.cos(angle) - Math.sin(phi) * Math.sin(lat))
  return { lat: Math.max(-90, Math.min(90, lat / DEGREES)), lon: wrapLongitude(lon / DEGREES) }
}

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
        const ellipsoidEdge =
          radius <= VINCENTY_EDGE_LIMIT_METRES ? vincentyEdgeAngle(centre, bearing, radius) : sphereEdge
        for (const factor of EDGE_FACTORS) {
          points.push(travel(centre, bearing, sphereEdge * (1 + factor)))
          points.push(travel(centre, bearing, ellipsoidEdge * (1 + factor)))
        }
      }
    }
  }
  return points
}

describe('a radius filter decides points at the edge of its circle', () => {
  let narsil: Narsil
  const points = edgePoints()

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(INDEX, { schema: { location: 'geopoint' } })
    const inserted = await narsil.insertBatch(
      INDEX,
      points.map((location, position) => ({ id: `p${position}`, location })),
    )
    expect(inserted.failed).toEqual([])
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await narsil.shutdown()
  })

  async function matchedIds(centre: Point, radius: number, highPrecision: boolean): Promise<Set<string>> {
    const found = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await narsil.listDocuments(INDEX, {
        filters: { fields: { location: { radius: { ...centre, distance: radius, unit: 'm', highPrecision } } } },
        limit: PAGE_SIZE,
        cursor,
      })
      for (const document of page.documents) found.add(String(document.id))
      cursor = page.cursor ?? undefined
    } while (cursor !== undefined)
    return found
  }

  for (const highPrecision of [false, true]) {
    const formula = highPrecision ? 'Vincenty' : 'Haversine'
    const distance = highPrecision ? vincentyMetres : haversineMetres
    it(
      `matches exactly the points within the radius under ${formula}`,
      async () => {
        for (const centre of CENTRES) {
          for (const radius of RADII_METRES) {
            const found = await matchedIds(centre, radius, highPrecision)
            const wrong: string[] = []
            for (const [position, point] of points.entries()) {
              const expected = distance(centre, point) <= radius
              if (found.has(`p${position}`) !== expected) wrong.push(`p${position} ${JSON.stringify(point)}`)
            }
            expect(wrong, `${formula} ${JSON.stringify(centre)} ${radius} m`).toEqual([])
          }
        }
      },
      TEST_TIMEOUT_MS,
    )
  }
})
