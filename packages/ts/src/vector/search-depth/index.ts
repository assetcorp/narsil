import { DEFAULT_EF_SEARCH } from '../hnsw/constants'
import {
  DEFAULT_EF_SEARCH_MARGIN_BY_BAND,
  DEFAULT_OSQ2_MIDDLE_RESCORE_DEPTH_WITHIN_WALK_PER_SQUARE_ROOT_OF_LIMIT,
  DEFAULT_RESCORE_DEPTH_BY_BITS,
  DEFAULT_RESCORE_DEPTH_FLOOR_PER_LIMIT_BY_BITS,
  NARROW_DIMENSION_LIMIT,
  WIDE_DIMENSION_LIMIT,
} from './constants'

function dimensionBand(dimension: number): 'narrow' | 'middle' | 'wide' {
  if (dimension < NARROW_DIMENSION_LIMIT) return 'narrow'
  return dimension < WIDE_DIMENSION_LIMIT ? 'middle' : 'wide'
}

export function defaultRescoreDepth(bits: 1 | 2 | 4 | 8, dimension: number, k: number): number {
  const band = dimensionBand(dimension)
  const { perLimit, perSquareRootOfLimit } = DEFAULT_RESCORE_DEPTH_BY_BITS[bits][band]
  const floor = DEFAULT_RESCORE_DEPTH_FLOOR_PER_LIMIT_BY_BITS[bits] * k
  const depth = Math.max(floor, Math.ceil(perLimit * k + perSquareRootOfLimit * Math.sqrt(k)))
  if (bits !== 2 || band !== 'middle') return depth
  const withinDefaultWalk = Math.min(
    k + DEFAULT_EF_SEARCH_MARGIN_BY_BAND.middle,
    Math.ceil(k + DEFAULT_OSQ2_MIDDLE_RESCORE_DEPTH_WITHIN_WALK_PER_SQUARE_ROOT_OF_LIMIT * Math.sqrt(k)),
  )
  return Math.max(depth, withinDefaultWalk)
}

export function defaultEfSearch(dimension: number, k: number): number {
  return Math.max(DEFAULT_EF_SEARCH, k + DEFAULT_EF_SEARCH_MARGIN_BY_BAND[dimensionBand(dimension)])
}
