const CONTINUATION_MASK = 0xc0
const CONTINUATION_BYTE = 0x80

function continues(bytes: Uint8Array, at: number, count: number): boolean {
  if (at + count > bytes.length) return false
  for (let k = 1; k <= count; k++) {
    if ((bytes[at + k] & CONTINUATION_MASK) !== CONTINUATION_BYTE) return false
  }
  return true
}

function sequenceLengthAt(bytes: Uint8Array, at: number): number {
  const lead = bytes[at]
  if (lead < 0x80) return 1
  if (lead >= 0xc2 && lead <= 0xdf) return continues(bytes, at, 1) ? 2 : 0
  if (lead >= 0xe0 && lead <= 0xef) {
    if (!continues(bytes, at, 2)) return 0
    const second = bytes[at + 1]
    if (lead === 0xe0 && second < 0xa0) return 0
    if (lead === 0xed && second > 0x9f) return 0
    return 3
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    if (!continues(bytes, at, 3)) return 0
    const second = bytes[at + 1]
    if (lead === 0xf0 && second < 0x90) return 0
    if (lead === 0xf4 && second > 0x8f) return 0
    return 4
  }
  return 0
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  let at = 0
  while (at < bytes.length) {
    const length = sequenceLengthAt(bytes, at)
    if (length === 0) return false
    at += length
  }
  return true
}
