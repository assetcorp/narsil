import type { GeoRegions } from '../../geo/storage'
import { typedRegion } from '../stored-values/regions'
import * as L from './layout'

export type FilterField =
  | { kind: 0; present: Uint32Array }
  | { kind: 1; present: Uint32Array; values: Float64Array; ordinals: Uint32Array }
  | { kind: 2; present: Uint32Array; trueBits: Uint32Array; falseBits: Uint32Array }
  | {
      kind: 3
      present: Uint32Array
      units: Uint16Array
      offsets: Uint32Array
      postingOffsets: Uint32Array
      postings: Uint32Array
      suffixOrder: Uint32Array
    }
  | { kind: 4; present: Uint32Array; geo: GeoRegions }

export function fieldRegions(field: FilterField): L.FilterRegion[] {
  if (field.kind === L.FILTER_NUMERIC) return [field.present, field.values, field.ordinals]
  if (field.kind === L.FILTER_BOOLEAN) return [field.present, field.trueBits, field.falseBits]
  if (field.kind === L.FILTER_ENUM)
    return [field.present, field.units, field.offsets, field.postingOffsets, field.postings, field.suffixOrder]
  if (field.kind === L.FILTER_GEO)
    return [field.present, field.geo.codes, field.geo.lat, field.geo.lon, field.geo.ordinals]
  return [field.present]
}

export function filterField(kind: number, regions: readonly L.FilterRegion[]): FilterField | null {
  const present = typedRegion(regions[0], 'Uint32Array')
  if (present === null || present.length === 0) return null
  if (kind === L.FILTER_ABSENT) return regions.length === 1 ? { kind, present } : null
  if (kind === L.FILTER_NUMERIC) {
    const values = typedRegion(regions[1], 'Float64Array')
    const ordinals = typedRegion(regions[2], 'Uint32Array')
    return regions.length === 3 && values !== null && ordinals !== null && values.length === ordinals.length
      ? { kind, present, values, ordinals }
      : null
  }
  if (kind === L.FILTER_BOOLEAN) {
    const trueBits = typedRegion(regions[1], 'Uint32Array')
    const falseBits = typedRegion(regions[2], 'Uint32Array')
    return regions.length === 3 &&
      trueBits !== null &&
      falseBits !== null &&
      trueBits.length > 0 &&
      falseBits.length > 0
      ? { kind, present, trueBits, falseBits }
      : null
  }
  if (kind === L.FILTER_ENUM) {
    const units = typedRegion(regions[1], 'Uint16Array')
    const offsets = typedRegion(regions[2], 'Uint32Array')
    const postingOffsets = typedRegion(regions[3], 'Uint32Array')
    const postings = typedRegion(regions[4], 'Uint32Array')
    const suffixOrder = typedRegion(regions[5], 'Uint32Array')
    return regions.length === 6 &&
      units !== null &&
      offsets !== null &&
      postingOffsets !== null &&
      postings !== null &&
      suffixOrder !== null &&
      offsets.length === suffixOrder.length + 1 &&
      postingOffsets.length === offsets.length
      ? { kind, present, units, offsets, postingOffsets, postings, suffixOrder }
      : null
  }
  if (kind === L.FILTER_GEO) {
    const codes = typedRegion(regions[1], 'BigUint64Array')
    const lat = typedRegion(regions[2], 'Float64Array')
    const lon = typedRegion(regions[3], 'Float64Array')
    const ordinals = typedRegion(regions[4], 'Uint32Array')
    return regions.length === 5 &&
      codes !== null &&
      lat !== null &&
      lon !== null &&
      ordinals !== null &&
      codes.length === lat.length &&
      codes.length === lon.length &&
      codes.length === ordinals.length
      ? { kind, present, geo: { codes, lat, lon, ordinals } }
      : null
  }
  return null
}
