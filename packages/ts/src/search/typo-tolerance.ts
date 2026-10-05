import { ErrorCodes, NarsilError } from '../errors'
import type { QueryParams } from '../types/search'
import { MAX_PREFIX_LENGTH, MAX_TOLERANCE } from './constants'

function requireIntegerUpTo(option: 'tolerance' | 'prefixLength', value: number | undefined, maximum: number): void {
  if (value === undefined || (Number.isInteger(value) && value >= 0 && value <= maximum)) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The query option "${option}" takes an integer from 0 to ${maximum}, and this query sets ${String(value)}`,
    { option, value: String(value), maximum },
  )
}

export function requireValidTypoTolerance(params: QueryParams): void {
  requireIntegerUpTo('tolerance', params.tolerance, MAX_TOLERANCE)
  requireIntegerUpTo('prefixLength', params.prefixLength, MAX_PREFIX_LENGTH)
}
