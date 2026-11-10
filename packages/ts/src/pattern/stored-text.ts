import type { NativeStoredValues } from '../vector/native/types/stored-values'

export function someStoredText(
  values: NativeStoredValues,
  ordinal: number,
  matches: (units: Uint16Array, start: number, length: number) => boolean,
): boolean {
  if (ordinal >= values.shapes.length) return false
  const shape = values.shapes[ordinal]
  if (shape !== 1 && shape !== 2) return false
  const first = values.starts[ordinal]
  const end = values.starts[ordinal + 1]
  if (first > end || end > values.kinds.length || (shape === 1 && end !== first + 1)) return false
  for (let at = first; at < end; at++) {
    if (values.kinds[at] !== 4) continue
    const start = values.textStart[at]
    const length = values.textLength[at]
    if (start > values.units.length || length > values.units.length - start) continue
    if (matches(values.units, start, length)) return true
  }
  return false
}
