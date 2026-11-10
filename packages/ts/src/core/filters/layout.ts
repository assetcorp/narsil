export const FILTER_TEST = 0
export const FILTER_AND = 1
export const FILTER_OR = 2
export const FILTER_NOT = 3
export const FILTER_ANDNOT = 4
export const FILTER_PRESENT = 5
export const FILTER_BITSET = 6

export const FILTER_ABSENT = 0
export const FILTER_NUMERIC = 1
export const FILTER_BOOLEAN = 2
export const FILTER_ENUM = 3
export const FILTER_GEO = 4

export const FILTER_EQ = 0
export const FILTER_GT = 1
export const FILTER_GTE = 2
export const FILTER_LT = 3
export const FILTER_LTE = 4
export const FILTER_BETWEEN = 5
export const FILTER_ANY = 6
export const FILTER_ALL = 7
export const FILTER_PREFIX = 8
export const FILTER_SUFFIX = 9
export const FILTER_RADIUS = 10
export const FILTER_POLYGON = 11

export type FilterRegion = Uint16Array | Uint32Array | Float64Array | BigUint64Array

export interface FilterProgram {
  plan: Uint32Array
  numbers: Float64Array
  units: Uint16Array
  offsets: Uint32Array
  lists: Uint32Array
  bitsets: readonly Uint32Array[]
  kinds: Uint8Array
  fields: readonly (readonly FilterRegion[])[]
  live: Uint32Array
}
