import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import type { StoredFieldReference } from './references'
import { checkedSize } from './storage'

function gatherField(
  rows: readonly (readonly StoredFieldReference[] | undefined)[],
  field: number,
): NativeStoredValues {
  let count = 0
  let units = 0
  let bytes = 0
  for (const row of rows) {
    const ref = row?.[field]
    if (ref === undefined) continue
    const { values, ordinal } = ref
    const end = values.starts[ordinal + 1]
    count = checkedSize(count + end - values.starts[ordinal])
    for (let at = values.starts[ordinal]; at < end; at++) {
      if (values.kinds[at] === 4) units = checkedSize(units + values.textLength[at])
      else if (values.kinds[at] === 5) bytes = checkedSize(bytes + values.textLength[at])
    }
  }
  const result: NativeStoredValues = {
    shapes: new Uint8Array(rows.length),
    starts: new Uint32Array(rows.length + 1),
    kinds: new Uint8Array(count),
    numbers: new Float64Array(count),
    textStart: new Uint32Array(count),
    textLength: new Uint32Array(count),
    units: new Uint16Array(units),
    bytes: new Uint8Array(bytes),
  }
  let next = 0
  let unit = 0
  let byte = 0
  for (let row = 0; row < rows.length; row++) {
    result.starts[row] = next
    const ref = rows[row]?.[field]
    if (ref === undefined) continue
    const { values, ordinal } = ref
    result.shapes[row] = values.shapes[ordinal]
    const start = values.starts[ordinal]
    const end = values.starts[ordinal + 1]
    result.kinds.set(values.kinds.subarray(start, end), next)
    result.numbers.set(values.numbers.subarray(start, end), next)
    result.textLength.set(values.textLength.subarray(start, end), next)
    for (let at = start; at < end; at++, next++) {
      const textStart = values.textStart[at]
      const textEnd = textStart + values.textLength[at]
      if (values.kinds[at] === 4) {
        result.textStart[next] = unit
        result.units.set(values.units.subarray(textStart, textEnd), unit)
        unit += textEnd - textStart
      } else if (values.kinds[at] === 5) {
        result.textStart[next] = byte
        result.bytes.set(values.bytes.subarray(textStart, textEnd), byte)
        byte += textEnd - textStart
      }
    }
  }
  result.starts[rows.length] = next
  return result
}

export function gatheredStoredFields(
  rows: readonly (readonly StoredFieldReference[] | undefined)[],
  fieldCount: number,
): { fields: NativeStoredValues[]; ordinals: Uint32Array } {
  checkedSize(rows.length)
  const first = rows[0]
  if (
    first !== undefined &&
    first.length > 0 &&
    first.length === fieldCount &&
    rows.every(
      row =>
        row !== undefined &&
        row.length === fieldCount &&
        row.every((ref, field) => ref.values === first[field].values && ref.ordinal === row[0].ordinal),
    )
  ) {
    return { fields: first.map(ref => ref.values), ordinals: Uint32Array.from(rows, row => row?.[0].ordinal ?? 0) }
  }
  return {
    fields: Array.from({ length: fieldCount }, (_, field) => gatherField(rows, field)),
    ordinals: Uint32Array.from(rows, (_, ordinal) => ordinal),
  }
}
