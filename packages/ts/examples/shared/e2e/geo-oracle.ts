import type { OraclePlace } from './places-oracle'

export interface Corner {
  lat: number
  lon: number
}

export interface ExpectedMatches {
  inside: Set<string>
  outside: Set<string>
}

const MEAN_EARTH_RADIUS_KM = 6371.0088
const BOUNDARY_SHARE = 0.005
const EDGE_MARGIN_DEGREES = 0.01

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

export function greatCircleKm(from: Corner, to: Corner): number {
  const deltaLat = radians(to.lat - from.lat)
  const deltaLon = radians(to.lon - from.lon)
  const chord =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(deltaLon / 2) ** 2
  return 2 * MEAN_EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(chord)))
}

export function placesWithin(places: readonly OraclePlace[], centre: Corner, distanceKm: number): ExpectedMatches {
  const inside = new Set<string>()
  const outside = new Set<string>()
  const margin = distanceKm * BOUNDARY_SHARE
  for (const place of places) {
    const distance = greatCircleKm(centre, place.location)
    if (distance < distanceKm - margin) inside.add(place.id)
    else if (distance > distanceKm + margin) outside.add(place.id)
  }
  return { inside, outside }
}

function crossesRay(point: Corner, from: Corner, to: Corner): boolean {
  if (from.lat > point.lat === to.lat > point.lat) return false
  const lonAtLat = from.lon + ((point.lat - from.lat) / (to.lat - from.lat)) * (to.lon - from.lon)
  return point.lon < lonAtLat
}

function distanceToEdge(point: Corner, from: Corner, to: Corner): number {
  const edgeLon = to.lon - from.lon
  const edgeLat = to.lat - from.lat
  const lengthSquared = edgeLon * edgeLon + edgeLat * edgeLat
  const along =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.lon - from.lon) * edgeLon + (point.lat - from.lat) * edgeLat) / lengthSquared))
  return Math.hypot(point.lon - (from.lon + along * edgeLon), point.lat - (from.lat + along * edgeLat))
}

export function placesInside(places: readonly OraclePlace[], corners: readonly Corner[]): ExpectedMatches {
  const inside = new Set<string>()
  const outside = new Set<string>()
  for (const place of places) {
    let crossings = 0
    let nearEdge = false
    for (let i = 0; i < corners.length; i++) {
      const from = corners[i]
      const to = corners[(i + 1) % corners.length]
      if (from === undefined || to === undefined) continue
      if (crossesRay(place.location, from, to)) crossings++
      if (distanceToEdge(place.location, from, to) < EDGE_MARGIN_DEGREES) nearEdge = true
    }
    if (nearEdge) continue
    if (crossings % 2 === 1) inside.add(place.id)
    else outside.add(place.id)
  }
  return { inside, outside }
}
