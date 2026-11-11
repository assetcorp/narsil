import type { OptionalCodeHost } from '../engine/optional-code-host'

type GeoHost = Pick<
  OptionalCodeHost,
  | 'ANTIMERIDIAN_SPAN_DEGREES'
  | 'bitsetSet'
  | 'DEG_TO_RAD'
  | 'EARTH_RADIUS_METERS'
  | 'ErrorCodes'
  | 'FieldPresence'
  | 'FILTER_RADIUS'
  | 'fromWords'
  | 'FULL_TURN_DEGREES'
  | 'highWord'
  | 'INFINITE_HIGH_WORD'
  | 'LOCATION_CELLS_PER_AXIS'
  | 'LOCATION_CODE_BITS_PER_AXIS'
  | 'lowWord'
  | 'MAGNITUDE_MASK'
  | 'MAX_COVERING_CELLS'
  | 'MAX_LATITUDE_DEGREES'
  | 'MAX_LONGITUDE_DEGREES'
  | 'MIN_POLYGON_POINTS'
  | 'NarsilError'
  | 'scaleByPowerOfTwo'
  | 'withLowWord'
>

export let ANTIMERIDIAN_SPAN_DEGREES: GeoHost['ANTIMERIDIAN_SPAN_DEGREES']
export let bitsetSet: GeoHost['bitsetSet']
export let DEG_TO_RAD: GeoHost['DEG_TO_RAD']
export let EARTH_RADIUS_METERS: GeoHost['EARTH_RADIUS_METERS']
export let ErrorCodes: GeoHost['ErrorCodes']
export let FieldPresence: GeoHost['FieldPresence']
export type FieldPresence = InstanceType<GeoHost['FieldPresence']>
export let FILTER_RADIUS: GeoHost['FILTER_RADIUS']
export let fromWords: GeoHost['fromWords']
export let FULL_TURN_DEGREES: GeoHost['FULL_TURN_DEGREES']
export let highWord: GeoHost['highWord']
export let INFINITE_HIGH_WORD: GeoHost['INFINITE_HIGH_WORD']
export let LOCATION_CELLS_PER_AXIS: GeoHost['LOCATION_CELLS_PER_AXIS']
export let LOCATION_CODE_BITS_PER_AXIS: GeoHost['LOCATION_CODE_BITS_PER_AXIS']
export let lowWord: GeoHost['lowWord']
export let MAGNITUDE_MASK: GeoHost['MAGNITUDE_MASK']
export let MAX_COVERING_CELLS: GeoHost['MAX_COVERING_CELLS']
export let MAX_LATITUDE_DEGREES: GeoHost['MAX_LATITUDE_DEGREES']
export let MAX_LONGITUDE_DEGREES: GeoHost['MAX_LONGITUDE_DEGREES']
export let MIN_POLYGON_POINTS: GeoHost['MIN_POLYGON_POINTS']
export let NarsilError: GeoHost['NarsilError']
export let scaleByPowerOfTwo: GeoHost['scaleByPowerOfTwo']
export let withLowWord: GeoHost['withLowWord']

export function bindGeoHost(host: GeoHost): void {
  ;({
    ANTIMERIDIAN_SPAN_DEGREES,
    bitsetSet,
    DEG_TO_RAD,
    EARTH_RADIUS_METERS,
    ErrorCodes,
    FieldPresence,
    FILTER_RADIUS,
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
    NarsilError,
    scaleByPowerOfTwo,
    withLowWord,
  } = host)
}
