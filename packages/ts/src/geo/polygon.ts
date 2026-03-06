export function isPointInPolygon(lat: number, lon: number, polygon: Array<{ lat: number; lon: number }>): boolean {
  if (polygon.length < 3) return false

  let inside = false
  const n = polygon.length

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const lonI = polygon[i].lon
    const latI = polygon[i].lat
    const lonJ = polygon[j].lon
    const latJ = polygon[j].lat

    if (lonI > lon !== lonJ > lon) {
      const slope = (latJ - latI) / (lonJ - lonI)
      const intersectLat = latI + slope * (lon - lonI)
      if (lat < intersectLat) {
        inside = !inside
      }
    }
  }

  return inside
}

export function polygonCentroid(polygon: Array<{ lat: number; lon: number }>): { lat: number; lon: number } {
  if (polygon.length < 3) {
    return { lat: 0, lon: 0 }
  }

  let signedArea = 0
  let cx = 0
  let cy = 0
  const n = polygon.length

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const cross = polygon[i].lat * polygon[j].lon - polygon[j].lat * polygon[i].lon

    signedArea += cross
    cx += (polygon[i].lat + polygon[j].lat) * cross
    cy += (polygon[i].lon + polygon[j].lon) * cross
  }

  signedArea /= 2

  if (signedArea === 0) {
    let latSum = 0
    let lonSum = 0
    for (let i = 0; i < n; i++) {
      latSum += polygon[i].lat
      lonSum += polygon[i].lon
    }
    return { lat: latSum / n, lon: lonSum / n }
  }

  const factor = 6 * signedArea

  return {
    lat: cx / factor,
    lon: cy / factor,
  }
}
