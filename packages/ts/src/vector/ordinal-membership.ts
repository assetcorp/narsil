import type { OrdinalFilter } from './ordinal-filter'

export function ordinalFilterHas(filter: OrdinalFilter, ordinal: number): boolean {
  const index = ordinal >>> 3
  if (index >= filter.bits.length) return false
  return (filter.bits[index] & (1 << (ordinal & 7))) !== 0
}
