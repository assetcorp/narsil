const EARTH_RADIUS_METERS = 6_371_008.8
const DEG_TO_RAD = Math.PI / 180

export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * DEG_TO_RAD
  const phi2 = lat2 * DEG_TO_RAD
  const deltaPhi = (lat2 - lat1) * DEG_TO_RAD
  const deltaLambda = (lon2 - lon1) * DEG_TO_RAD

  const halfDeltaPhi = Math.sin(deltaPhi / 2)
  const halfDeltaLambda = Math.sin(deltaLambda / 2)

  const a = halfDeltaPhi * halfDeltaPhi + Math.cos(phi1) * Math.cos(phi2) * halfDeltaLambda * halfDeltaLambda

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return EARTH_RADIUS_METERS * c
}
