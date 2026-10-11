import { describe, expect, it } from 'vitest'
import { createGeoIndex, type GeoIndex } from '../../geo/geo-index'
import { haversineDistance } from '../../geo/haversine'
import { vincentyDistance } from '../../geo/vincenty'
import { insidePolygon } from '../e2e/filters/oracle'
import { type Random, seededRandom } from '../filters/pattern/random-corpus'

interface Point {
  lat: number
  lon: number
}

function wrapLongitude(lon: number): number {
  if (lon > 180) return lon - 360
  if (lon < -180) return lon + 360
  return lon
}

function clampLatitude(lat: number): number {
  return Math.max(-90, Math.min(90, lat))
}

function near(random: Random, centre: Point, spread: number): Point {
  return {
    lat: clampLatitude(centre.lat + (random() - 0.5) * spread),
    lon: wrapLongitude(centre.lon + (random() - 0.5) * spread),
  }
}

const EDGES_OF_THE_GLOBE: Point[] = [
  { lat: 0, lon: 0 },
  { lat: 90, lon: 180 },
  { lat: 90, lon: 0 },
  { lat: -90, lon: -180 },
  { lat: 0, lon: 180 },
  { lat: 0, lon: -180 },
  { lat: 45, lon: 179.99999 },
  { lat: -45, lon: -179.99999 },
]

function pointCorpus(random: Random): Map<number, Point> {
  const points = new Map<number, Point>()
  const add = (point: Point) => points.set(points.size, point)
  for (let i = 0; i < 1_000; i++) add({ lat: random() * 180 - 90, lon: random() * 360 - 180 })
  for (let i = 0; i < 800; i++) add(near(random, { lat: 51.5, lon: -0.1 }, 0.1))
  for (let i = 0; i < 400; i++) add(near(random, { lat: 89.95, lon: random() * 360 - 180 }, 0.1))
  for (let i = 0; i < 400; i++) add(near(random, { lat: -89.95, lon: random() * 360 - 180 }, 0.1))
  for (let i = 0; i < 600; i++) add(near(random, { lat: random() * 120 - 60, lon: 180 }, 0.4))
  for (const point of EDGES_OF_THE_GLOBE) add(point)
  return points
}

function loaded(points: Map<number, Point>): GeoIndex {
  const index = createGeoIndex()
  for (const [docId, point] of points) index.insert(docId, point.lat, point.lon)
  return index
}

function sorted(ids: Iterable<number>): number[] {
  return [...ids].sort((left, right) => left - right)
}

function bruteRadius(points: Map<number, Point>, centre: Point, metres: number, inside: boolean, precise: boolean) {
  const distance = precise ? vincentyDistance : haversineDistance
  const ids: number[] = []
  for (const [docId, point] of points) {
    if (distance(centre.lat, centre.lon, point.lat, point.lon) <= metres === inside) ids.push(docId)
  }
  return sorted(ids)
}

function brutePolygon(points: Map<number, Point>, ring: Point[], inside: boolean): number[] {
  const ids: number[] = []
  for (const [docId, point] of points) if (insidePolygon(point, ring) === inside) ids.push(docId)
  return sorted(ids)
}

function starRing(random: Random, centre: Point, radius: number, corners: number): Point[] {
  return Array.from({ length: corners }, (_, at) => {
    const angle = (2 * Math.PI * at) / corners
    const reach = radius * (0.3 + 0.7 * random())
    return {
      lat: clampLatitude(centre.lat + reach * Math.sin(angle)),
      lon: wrapLongitude(centre.lon + reach * Math.cos(angle)),
    }
  })
}

function churned(random: Random): Map<number, Point> {
  const points = pointCorpus(random)
  const index = loaded(points)
  for (const docId of [...points.keys()]) {
    const roll = random()
    if (roll < 0.1) {
      index.remove(docId)
      points.delete(docId)
    } else if (roll < 0.15) {
      const moved = { lat: random() * 180 - 90, lon: random() * 360 - 180 }
      index.insert(docId, moved.lat, moved.lon)
      points.set(docId, moved)
    }
  }
  churnedIndexes.set(points, index)
  return points
}

const churnedIndexes = new WeakMap<Map<number, Point>, GeoIndex>()

function indexOf(points: Map<number, Point>): GeoIndex {
  const index = churnedIndexes.get(points)
  if (index === undefined) throw new Error('This corpus has no index')
  return index
}

describe('the location index', () => {
  it('finds exactly the points that a check of every point finds, for circles of every size and place', () => {
    const random = seededRandom(7)
    const points = churned(random)
    const index = indexOf(points)
    const corpus = [...points.values()]
    for (let query = 0; query < 600; query++) {
      const centre = query % 3 === 0 ? corpus[Math.floor(random() * corpus.length)] : EDGES_OF_THE_GLOBE[query % 8]
      const metres = query % 5 === 0 ? 0 : 10 ** (random() * 7.5)
      const inside = random() < 0.7
      const precise = random() < 0.3
      const found = sorted(index.radiusQuery(centre.lat, centre.lon, metres, inside, precise))
      expect(found, JSON.stringify({ centre, metres, inside, precise })).toEqual(
        bruteRadius(points, centre, metres, inside, precise),
      )
    }
  }, 30_000)

  it('includes a point that lies exactly on the edge of the circle', () => {
    const random = seededRandom(11)
    const points = churned(random)
    const index = indexOf(points)
    const corpus = [...points.entries()]
    for (let query = 0; query < 300; query++) {
      const [, centre] = corpus[Math.floor(random() * corpus.length)]
      const [edgeId, edge] = corpus[Math.floor(random() * corpus.length)]
      const metres = haversineDistance(centre.lat, centre.lon, edge.lat, edge.lon)
      expect(index.radiusQuery(centre.lat, centre.lon, metres, true, false).has(edgeId)).toBe(true)
      const preciseMetres = vincentyDistance(centre.lat, centre.lon, edge.lat, edge.lon)
      expect(index.radiusQuery(centre.lat, centre.lon, preciseMetres, true, true).has(edgeId)).toBe(true)
    }
  })

  it('finds exactly the points that ray casting over every point finds, for polygons of every shape and place', () => {
    const random = seededRandom(19)
    const points = churned(random)
    const index = indexOf(points)
    for (let query = 0; query < 300; query++) {
      const centre = query % 4 === 0 ? { lat: random() * 100 - 50, lon: 179.5 } : near(random, { lat: 0, lon: 0 }, 160)
      const ring = starRing(random, centre, 0.05 + random() * 40, 3 + Math.floor(random() * 200))
      const inside = random() < 0.7
      expect(sorted(index.polygonQuery(ring, inside)), JSON.stringify(ring).slice(0, 200)).toEqual(
        brutePolygon(points, ring, inside),
      )
    }
  }, 30_000)

  it('matches a ring spanning more than half the globe on the left of its path', () => {
    const points = churned(seededRandom(23))
    const index = indexOf(points)
    const rings: Point[][] = [
      [
        { lat: -60, lon: -170 },
        { lat: -60, lon: 0 },
        { lat: -60, lon: 170 },
        { lat: 60, lon: 170 },
        { lat: 60, lon: 0 },
        { lat: 60, lon: -170 },
      ],
      [
        { lat: -10, lon: 170 },
        { lat: -10, lon: -170 },
        { lat: 10, lon: -170 },
        { lat: 10, lon: 170 },
      ],
    ]
    for (const ring of rings) {
      for (const inside of [true, false]) {
        expect(sorted(index.polygonQuery(ring, inside))).toEqual(brutePolygon(points, ring, inside))
      }
    }
  })

  it('answers the same after it writes its points out and reads them back', () => {
    const random = seededRandom(29)
    const points = churned(random)
    const restored = createGeoIndex()
    restored.deserialize(indexOf(points).serialize())
    expect(restored.serialize()).toHaveLength(points.size)
    for (let query = 0; query < 50; query++) {
      const centre = { lat: random() * 180 - 90, lon: random() * 360 - 180 }
      const metres = 10 ** (random() * 7)
      expect(sorted(restored.radiusQuery(centre.lat, centre.lon, metres, true, false))).toEqual(
        bruteRadius(points, centre, metres, true, false),
      )
    }
  })

  it('keeps one point for a document that it stores twice', () => {
    const index = createGeoIndex()
    index.insert(1, 10, 10)
    index.insert(1, -10, -10)
    expect(index.serialize()).toEqual([{ lat: -10, lon: -10, docId: 1 }])
    expect(sorted(index.radiusQuery(10, 10, 1_000, true, false))).toEqual([])
    index.remove(1)
    expect(index.serialize()).toEqual([])
  })
})
