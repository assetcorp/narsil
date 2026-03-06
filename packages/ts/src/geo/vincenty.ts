import { haversineDistance } from './haversine'

const WGS84_A = 6_378_137.0
const WGS84_F = 1 / 298.257223563
const WGS84_B = WGS84_A * (1 - WGS84_F)
const DEG_TO_RAD = Math.PI / 180
const MAX_ITERATIONS = 200
const CONVERGENCE_THRESHOLD = 1e-12

export function vincentyDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * DEG_TO_RAD
  const phi2 = lat2 * DEG_TO_RAD
  const L = (lon2 - lon1) * DEG_TO_RAD

  const U1 = Math.atan((1 - WGS84_F) * Math.tan(phi1))
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(phi2))

  const sinU1 = Math.sin(U1)
  const cosU1 = Math.cos(U1)
  const sinU2 = Math.sin(U2)
  const cosU2 = Math.cos(U2)

  let lambda = L
  let prevLambda: number
  let sinSigma = 0
  let cosSigma = 0
  let sigma = 0
  let sinAlpha = 0
  let cos2Alpha = 0
  let cos2SigmaM = 0
  let iterations = MAX_ITERATIONS

  do {
    const sinLambda = Math.sin(lambda)
    const cosLambda = Math.cos(lambda)

    const term1 = cosU2 * sinLambda
    const term2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda

    sinSigma = Math.sqrt(term1 * term1 + term2 * term2)

    if (sinSigma === 0) return 0

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
    sigma = Math.atan2(sinSigma, cosSigma)

    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma
    cos2Alpha = 1 - sinAlpha * sinAlpha

    cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha

    const C = (WGS84_F / 16) * cos2Alpha * (4 + WGS84_F * (4 - 3 * cos2Alpha))

    prevLambda = lambda
    lambda =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
  } while (Math.abs(lambda - prevLambda) > CONVERGENCE_THRESHOLD && --iterations > 0)

  if (iterations === 0) {
    return haversineDistance(lat1, lon1, lat2, lon2)
  }

  const uSq = (cos2Alpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B)
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))

  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))

  return WGS84_B * A * (sigma - deltaSigma)
}
