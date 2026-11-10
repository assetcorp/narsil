const UTF8_LEADS = [0, 0, 0xc0, 0xe0, 0xf0]

export function holdsLoneSurrogate(units: Uint16Array, start: number, length: number): boolean {
  const end = start + length
  for (let at = start; at < end; at++) {
    const unit = units[at]
    if (unit < 0xd800 || unit >= 0xe000) continue
    if (unit >= 0xdc00 || at + 1 >= end || units[at + 1] < 0xdc00 || units[at + 1] >= 0xe000) return true
    at++
  }
  return false
}

function utf8Width(point: number): number {
  if (point < 0x80) return 1
  if (point < 0x800) return 2
  return point < 0x10000 ? 3 : 4
}

function utf8Byte(point: number, width: number, index: number): number {
  if (width === 1) return point
  const shift = 6 * (width - 1 - index)
  return index === 0 ? UTF8_LEADS[width] | (point >> shift) : 0x80 | ((point >> shift) & 0x3f)
}

export function compareTableToUnits(
  table: Uint8Array,
  from: number,
  to: number,
  units: Uint16Array,
  start: number,
  length: number,
): number {
  let byte = from
  const end = start + length
  for (let at = start; at < end; at++) {
    let point = units[at]
    if (point >= 0xd800 && point < 0xdc00) point = 0x10000 + ((point - 0xd800) << 10) + (units[++at] - 0xdc00)
    const width = utf8Width(point)
    for (let index = 0; index < width; index++) {
      if (byte >= to) return -1
      const order = table[byte++] - utf8Byte(point, width, index)
      if (order !== 0) return order
    }
  }
  return byte < to ? 1 : 0
}

function codePointRank(unit: number): number {
  if (unit < 0xd800) return unit
  return unit < 0xe000 ? unit + 0x2000 : unit - 0x800
}

export function compareUnits(
  units: Uint16Array,
  left: number,
  leftLength: number,
  right: number,
  rightLength: number,
): number {
  const shared = leftLength < rightLength ? leftLength : rightLength
  for (let at = 0; at < shared; at++) {
    const order = codePointRank(units[left + at]) - codePointRank(units[right + at])
    if (order !== 0) return order
  }
  return leftLength - rightLength
}

export function sameUnits(
  units: Uint16Array,
  left: number,
  leftLength: number,
  right: number,
  rightLength: number,
): boolean {
  if (leftLength !== rightLength) return false
  for (let at = 0; at < leftLength; at++) if (units[left + at] !== units[right + at]) return false
  return true
}
