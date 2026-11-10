import {
  ANTIMERIDIAN_SPAN_DEGREES,
  DEG_TO_RAD,
  EARTH_RADIUS_METERS,
  FULL_TURN_DEGREES,
  LOCATION_CELLS_PER_AXIS,
  LOCATION_CODE_BITS_PER_AXIS,
  MAX_COVERING_CELLS,
  MAX_LATITUDE_DEGREES,
  MAX_LONGITUDE_DEGREES,
  MIN_POLYGON_POINTS,
} from '../../geo/constants'
import {
  fromWords,
  highWord,
  INFINITE_HIGH_WORD,
  lowWord,
  MAGNITUDE_MASK,
  scaleByPowerOfTwo,
  withLowWord,
} from '../../math/words'

export function geoHostPart() {
  return {
    ANTIMERIDIAN_SPAN_DEGREES,
    DEG_TO_RAD,
    EARTH_RADIUS_METERS,
    fromWords,
    FULL_TURN_DEGREES,
    highWord,
    INFINITE_HIGH_WORD,
    LOCATION_CELLS_PER_AXIS,
    LOCATION_CODE_BITS_PER_AXIS,
    lowWord,
    MAGNITUDE_MASK,
    MAX_COVERING_CELLS,
    MAX_LATITUDE_DEGREES,
    MAX_LONGITUDE_DEGREES,
    MIN_POLYGON_POINTS,
    scaleByPowerOfTwo,
    withLowWord,
  }
}
