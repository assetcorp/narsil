import { asin } from '../../math/inverse'
import { sin } from '../../math/trig'
import { type LocationBox, longitudeBoxes } from '../cells'
import { DEG_TO_RAD, EARTH_RADIUS_METERS, MAX_LATITUDE_DEGREES, MAX_LONGITUDE_DEGREES } from '../constants'
import { RADIUS_BOX_MARGIN_RADIANS, RADIUS_BOX_MARGIN_RATIO } from './constants'

export function radiusBoxes(lat: number, lon: number, distanceMeters: number, latitudeCosine: number): LocationBox[] {
  const angle = (distanceMeters / EARTH_RADIUS_METERS) * RADIUS_BOX_MARGIN_RATIO + RADIUS_BOX_MARGIN_RADIANS
  const angleDegrees = angle / DEG_TO_RAD
  const south = lat - angleDegrees
  const north = lat + angleDegrees
  if (angle >= Math.PI || south <= -MAX_LATITUDE_DEGREES || north >= MAX_LATITUDE_DEGREES) {
    return [
      {
        south: Math.max(south, -MAX_LATITUDE_DEGREES),
        north: Math.min(north, MAX_LATITUDE_DEGREES),
        west: -MAX_LONGITUDE_DEGREES,
        east: MAX_LONGITUDE_DEGREES,
      },
    ]
  }
  const spread = asin(sin(angle) / latitudeCosine) / DEG_TO_RAD
  return longitudeBoxes(south, north, lon - spread, lon + spread)
}
