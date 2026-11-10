import { ErrorCodes, NarsilError } from '../../errors'

export interface EnumRegions {
  values: readonly string[]
  units: Uint16Array
  offsets: Uint32Array
  postingOffsets: Uint32Array
  postings: Uint32Array
  suffixOrder: Uint32Array
}

export function enumRegionBytes(regions: EnumRegions | null): number {
  if (regions === null) return 0
  return (
    regions.units.byteLength +
    regions.offsets.byteLength +
    regions.postingOffsets.byteLength +
    regions.postings.byteLength +
    regions.suffixOrder.byteLength
  )
}

function checkedLength(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The enum field exceeds its region layout')
  return length
}

function compareSuffix(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let at = 1; at <= length; at++) {
    const difference = left.charCodeAt(left.length - at) - right.charCodeAt(right.length - at)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

export function buildEnumRegions(entries: ReadonlyMap<string, ReadonlySet<number>>): EnumRegions {
  checkedLength(entries.size)
  const values = [...entries.keys()].sort()
  const offsets = new Uint32Array(values.length + 1)
  const postingOffsets = new Uint32Array(values.length + 1)
  let unitCount = 0
  let postingCount = 0
  for (let at = 0; at < values.length; at++) {
    const value = values[at]
    if (value.length > 0x40000000)
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The enum string exceeds the text layout')
    unitCount = checkedLength(unitCount + value.length)
    postingCount = checkedLength(postingCount + (entries.get(value)?.size ?? 0))
    offsets[at + 1] = unitCount
    postingOffsets[at + 1] = postingCount
  }
  const units = new Uint16Array(unitCount)
  const postings = new Uint32Array(postingCount)
  for (let at = 0; at < values.length; at++) {
    const value = values[at]
    for (let unit = 0; unit < value.length; unit++) units[offsets[at] + unit] = value.charCodeAt(unit)
    let start = postingOffsets[at]
    const ordinals = entries.get(value)
    if (ordinals !== undefined) for (const ordinal of ordinals) postings[start++] = ordinal
  }
  const suffixOrder = Uint32Array.from({ length: values.length }, (_, at) => at)
  suffixOrder.sort((left, right) => compareSuffix(values[left], values[right]))
  return { values, units, offsets, postingOffsets, postings, suffixOrder }
}
