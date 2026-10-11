import {
  DEG_TO_RAD,
  EARTH_RADIUS_METERS,
  FULL_TURN_DEGREES,
  LOCATION_CODE_BITS_PER_AXIS,
  MAX_COVERING_CELLS,
  MAX_LATITUDE_DEGREES,
  MAX_LONGITUDE_DEGREES,
  RADIUS_BOX_MARGIN_RADIANS,
  RADIUS_BOX_MARGIN_RATIO,
} from './constants'

export interface LocationBox {
  south: number
  north: number
  west: number
  east: number
}

export interface CodeRange {
  from: number
  to: number
}

const AXIS_CELLS = 2 ** LOCATION_CODE_BITS_PER_AXIS

function axisCell(value: number, lowest: number, span: number): number {
  const cell = Math.floor(((value - lowest) / span) * AXIS_CELLS)
  if (!(cell > 0)) return 0
  return cell >= AXIS_CELLS ? AXIS_CELLS - 1 : cell
}

function latitudeCell(lat: number): number {
  return axisCell(lat, -MAX_LATITUDE_DEGREES, 2 * MAX_LATITUDE_DEGREES)
}

function longitudeCell(lon: number): number {
  return axisCell(lon, -MAX_LONGITUDE_DEGREES, FULL_TURN_DEGREES)
}

function interleave(row: number, column: number, bits: number): number {
  let code = 0
  for (let bit = bits - 1; bit >= 0; bit--) code = code * 4 + ((row >>> bit) & 1) * 2 + ((column >>> bit) & 1)
  return code
}

export function locationCode(lat: number, lon: number): number {
  return interleave(latitudeCell(lat), longitudeCell(lon), LOCATION_CODE_BITS_PER_AXIS)
}

function appendBoxRanges(box: LocationBox, out: CodeRange[]): void {
  const south = latitudeCell(box.south)
  const north = latitudeCell(box.north)
  const west = longitudeCell(box.west)
  const east = longitudeCell(box.east)
  let level = LOCATION_CODE_BITS_PER_AXIS
  while (level > 0) {
    const shift = LOCATION_CODE_BITS_PER_AXIS - level
    const rows = (north >>> shift) - (south >>> shift) + 1
    const columns = (east >>> shift) - (west >>> shift) + 1
    if (rows * columns <= MAX_COVERING_CELLS) break
    level--
  }
  const shift = LOCATION_CODE_BITS_PER_AXIS - level
  const codesPerCell = 4 ** shift
  for (let row = south >>> shift; row <= north >>> shift; row++) {
    for (let column = west >>> shift; column <= east >>> shift; column++) {
      const from = interleave(row, column, level) * codesPerCell
      out.push({ from, to: from + codesPerCell })
    }
  }
}

export function coveringRanges(boxes: readonly LocationBox[]): CodeRange[] {
  const ranges: CodeRange[] = []
  for (const box of boxes) appendBoxRanges(box, ranges)
  ranges.sort((left, right) => left.from - right.from)
  const merged: CodeRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.from <= last.to) {
      if (range.to > last.to) last.to = range.to
    } else {
      merged.push({ from: range.from, to: range.to })
    }
  }
  return merged
}

export function longitudeBoxes(south: number, north: number, west: number, east: number): LocationBox[] {
  if (east - west >= FULL_TURN_DEGREES) {
    return [{ south, north, west: -MAX_LONGITUDE_DEGREES, east: MAX_LONGITUDE_DEGREES }]
  }
  if (west < -MAX_LONGITUDE_DEGREES) {
    return [
      { south, north, west: west + FULL_TURN_DEGREES, east: MAX_LONGITUDE_DEGREES },
      { south, north, west: -MAX_LONGITUDE_DEGREES, east },
    ]
  }
  if (east > MAX_LONGITUDE_DEGREES) {
    return [
      { south, north, west, east: MAX_LONGITUDE_DEGREES },
      { south, north, west: -MAX_LONGITUDE_DEGREES, east: east - FULL_TURN_DEGREES },
    ]
  }
  return [{ south, north, west, east }]
}

export function radiusBoxes(lat: number, lon: number, distanceMeters: number): LocationBox[] {
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
  const spread = Math.asin(Math.sin(angle) / Math.cos(lat * DEG_TO_RAD)) / DEG_TO_RAD
  return longitudeBoxes(south, north, lon - spread, lon + spread)
}
