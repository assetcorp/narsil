import { bitsetSet } from '../core/bitset'
import type { FilterField } from '../core/filters/fields'
import * as L from '../core/filters/layout'
import { coveringRanges } from './cells'
import { polygonBoxes, polygonContainment } from './polygon'
import { radiusBoxes, radiusCandidateTest } from './radius'
import { firstGeoAtOrAfter } from './storage'

export function filterGeoRegions(
  field: Extract<FilterField, { kind: 4 }>,
  program: L.FilterProgram,
  operator: number,
  operand: number,
  into: Uint32Array,
): void {
  const values = program.numbers
  let boxes: ReturnType<typeof radiusBoxes>
  let passes: (lat: number, lon: number) => boolean
  if (operator === L.FILTER_RADIUS) {
    const [lat, lon, distance, precise] = values.subarray(operand, operand + 4)
    boxes = radiusBoxes(lat, lon, distance)
    passes = radiusCandidateTest(lat, lon, distance, precise === 1)
  } else {
    const points = Array.from({ length: values[operand] }, (_, at) => ({
      lat: values[operand + 1 + at * 2],
      lon: values[operand + 2 + at * 2],
    }))
    boxes = polygonBoxes(points)
    passes = polygonContainment(points)
  }
  const geo = field.geo
  for (const range of coveringRanges(boxes)) {
    const end = BigInt(range.to)
    for (
      let at = firstGeoAtOrAfter(geo, geo.codes.length, BigInt(range.from));
      at < geo.codes.length && geo.codes[at] < end;
      at++
    ) {
      if (passes(geo.lat[at], geo.lon[at])) bitsetSet(into, geo.ordinals[at])
    }
  }
}
