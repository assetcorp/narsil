import { DEFAULT_EF_SEARCH } from '../hnsw/constants'
import {
  DEFAULT_EF_SEARCH_MARGIN_BY_BAND,
  DEFAULT_RESCORE_DEPTH_BY_BITS,
  NARROW_DIMENSION_LIMIT,
  WIDE_DIMENSION_LIMIT,
} from './constants'

function dimensionBand(dimension: number): 'narrow' | 'middle' | 'wide' {
  if (dimension < NARROW_DIMENSION_LIMIT) return 'narrow'
  return dimension < WIDE_DIMENSION_LIMIT ? 'middle' : 'wide'
}

export function defaultRescoreDepth(bits: 1 | 2 | 4 | 8, dimension: number, k: number): number {
  const { perLimit, perSquareRootOfLimit } = DEFAULT_RESCORE_DEPTH_BY_BITS[bits][dimensionBand(dimension)]
  return Math.max(k, Math.ceil(perLimit * k + perSquareRootOfLimit * Math.sqrt(k)))
}

export function defaultEfSearch(dimension: number, k: number): number {
  return Math.max(DEFAULT_EF_SEARCH, k + DEFAULT_EF_SEARCH_MARGIN_BY_BAND[dimensionBand(dimension)])
}
