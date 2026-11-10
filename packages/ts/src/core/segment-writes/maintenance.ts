import type { NativeSurfaceTable } from '../../vector/native/types/segments'
import { TERM_VACUUM_MIN_DEAD_TERMS } from '../inverted-index/constants'

export function sparseStrings(table: NativeSurfaceTable | null): boolean {
  if (table === null) return false
  const live = table.strings.header[1]
  const dead = table.strings.header[0] - live
  return dead >= TERM_VACUUM_MIN_DEAD_TERMS && dead > live
}
