import { ErrorCodes, NarsilError } from '../../../errors'
import { textRange } from '../../../search/sorting-code'
import { createBitSet } from '../../bitset'
import { truncateSortString } from '../../ordering'
import type { SortColumn } from './index'

export interface TextRangeBounds {
  lower: string | null
  lowerInclusive: boolean
  upper: string | null
  upperInclusive: boolean
}

function unitsOf(bound: string | null): Uint16Array | null {
  if (bound === null) return null
  const text = truncateSortString(bound)
  const units = new Uint16Array(text.length)
  for (let index = 0; index < text.length; index++) units[index] = text.charCodeAt(index)
  return units
}

export function selectTextRange(
  column: SortColumn,
  bounds: TextRangeBounds,
  capacity: number,
  live: Uint32Array,
): Uint32Array {
  const output = createBitSet(capacity)
  const status = textRange(
    column.regions(),
    unitsOf(bounds.lower),
    bounds.lowerInclusive,
    unitsOf(bounds.upper),
    bounds.upperInclusive,
    live,
    output,
  )
  if (status !== 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The text range could not be selected', { status: -status })
  return output
}
