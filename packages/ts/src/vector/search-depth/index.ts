import { DEFAULT_EF_SEARCH, ErrorCodes, NarsilError } from '#platform/vector-core-host'
import type { VectorQueryConfig } from '../../types/search'
import { MIN_OVERSAMPLE } from '../osq/constants'
import {
  DEFAULT_EF_SEARCH_MARGIN_BY_BAND,
  DEFAULT_OSQ2_MIDDLE_RESCORE_DEPTH_WITHIN_WALK_PER_SQUARE_ROOT_OF_LIMIT,
  DEFAULT_RESCORE_DEPTH_BY_BITS,
  DEFAULT_RESCORE_DEPTH_FLOOR_PER_LIMIT_BY_BITS,
  MAX_EF_SEARCH,
  MIN_EF_SEARCH,
  NARROW_DIMENSION_LIMIT,
  OVERSAMPLED_DEPTH_CAP,
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

function requireVectorOption(
  option: 'efSearch' | 'oversample',
  value: unknown,
  accepts: (value: number) => boolean,
  range: string,
): void {
  if (value === undefined || (typeof value === 'number' && accepts(value))) return
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `vector.${option} must be ${range}`, { [option]: value })
}

export function requireUsableVectorOptions(vectorConfig: VectorQueryConfig | undefined): void {
  requireVectorOption(
    'oversample',
    vectorConfig?.oversample,
    value => Number.isFinite(value) && value >= MIN_OVERSAMPLE,
    `a finite number of at least ${MIN_OVERSAMPLE}`,
  )
  requireVectorOption(
    'efSearch',
    vectorConfig?.efSearch,
    value => Number.isInteger(value) && value >= MIN_EF_SEARCH && value <= MAX_EF_SEARCH,
    `a whole number from ${MIN_EF_SEARCH} to ${MAX_EF_SEARCH}`,
  )
}

export function rescoreDepth(
  bits: 1 | 2 | 4 | 8,
  dimension: number,
  window: number,
  oversample: number | undefined,
): number {
  const defaultDepth = defaultRescoreDepth(bits, dimension, window)
  if (oversample === undefined) return defaultDepth
  return Math.min(Math.ceil(window * oversample), Math.max(OVERSAMPLED_DEPTH_CAP, defaultDepth))
}

export function defaultEfSearch(dimension: number, k: number): number {
  return Math.max(DEFAULT_EF_SEARCH, k + DEFAULT_EF_SEARCH_MARGIN_BY_BAND[dimensionBand(dimension)])
}
