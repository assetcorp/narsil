export type RangeAnswer =
  | { kind: 'whole' }
  | { kind: 'partial'; start: number; endExclusive: number }
  | { kind: 'unsatisfiable' }

const WHOLE: RangeAnswer = { kind: 'whole' }
const UNSATISFIABLE: RangeAnswer = { kind: 'unsatisfiable' }
const SINGLE_BYTE_RANGE = /^bytes=(\d{0,20})-(\d{0,20})$/

function ifRangeMatches(ifRange: string | undefined, entityTag: string): boolean {
  return ifRange === undefined || ifRange.trim() === `"${entityTag}"`
}

export function rangeOf(
  range: string | undefined,
  ifRange: string | undefined,
  entityTag: string,
  length: number,
): RangeAnswer {
  if (range === undefined || !ifRangeMatches(ifRange, entityTag)) return WHOLE
  const match = SINGLE_BYTE_RANGE.exec(range.trim())
  if (match === null) return WHOLE
  const [, first, last] = match
  if (first === '' && last === '') return WHOLE
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0 || length === 0) return UNSATISFIABLE
    return { kind: 'partial', start: Math.max(0, length - suffix), endExclusive: length }
  }
  const start = Number(first)
  if (last !== '' && Number(last) < start) return WHOLE
  if (start >= length) return UNSATISFIABLE
  const endExclusive = last === '' ? length : Math.min(length, Number(last) + 1)
  return { kind: 'partial', start, endExclusive }
}
