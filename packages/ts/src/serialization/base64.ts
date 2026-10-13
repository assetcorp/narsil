const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const PAD = 0x3d
const BYTES_PER_GROUP = 3
const CHARACTERS_PER_GROUP = 4
const ASCII_LIMIT = 128

const ENCODE = new Uint8Array(ALPHABET.length)
const DECODE = new Int8Array(ASCII_LIMIT).fill(-1)
for (let at = 0; at < ALPHABET.length; at++) {
  ENCODE[at] = ALPHABET.charCodeAt(at)
  DECODE[ALPHABET.charCodeAt(at)] = at
}

const asciiDecoder = new TextDecoder()

export function encodeBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.byteLength / BYTES_PER_GROUP) * CHARACTERS_PER_GROUP)
  let write = 0
  let read = 0
  for (; read + BYTES_PER_GROUP <= bytes.byteLength; read += BYTES_PER_GROUP) {
    const group = (bytes[read] << 16) | (bytes[read + 1] << 8) | bytes[read + 2]
    out[write++] = ENCODE[group >>> 18]
    out[write++] = ENCODE[(group >>> 12) & 0x3f]
    out[write++] = ENCODE[(group >>> 6) & 0x3f]
    out[write++] = ENCODE[group & 0x3f]
  }
  const left = bytes.byteLength - read
  if (left > 0) {
    const group = (bytes[read] << 16) | (left === 2 ? bytes[read + 1] << 8 : 0)
    out[write++] = ENCODE[group >>> 18]
    out[write++] = ENCODE[(group >>> 12) & 0x3f]
    out[write++] = left === 2 ? ENCODE[(group >>> 6) & 0x3f] : PAD
    out[write++] = PAD
  }
  return asciiDecoder.decode(out)
}

function sextetAt(text: string, at: number): number {
  const code = text.charCodeAt(at)
  return code < ASCII_LIMIT ? DECODE[code] : -1
}

export function decodeExactBase64(text: string): Uint8Array | null {
  if (text.length % CHARACTERS_PER_GROUP !== 0) return null
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / CHARACTERS_PER_GROUP) * BYTES_PER_GROUP - padding)
  const fullEnd = padding === 0 ? text.length : text.length - CHARACTERS_PER_GROUP
  let write = 0
  for (let at = 0; at < fullEnd; at += CHARACTERS_PER_GROUP) {
    const a = sextetAt(text, at)
    const b = sextetAt(text, at + 1)
    const c = sextetAt(text, at + 2)
    const d = sextetAt(text, at + 3)
    if ((a | b | c | d) < 0) return null
    const group = (a << 18) | (b << 12) | (c << 6) | d
    out[write++] = group >>> 16
    out[write++] = (group >>> 8) & 0xff
    out[write++] = group & 0xff
  }
  if (padding === 0) return out
  const a = sextetAt(text, fullEnd)
  const b = sextetAt(text, fullEnd + 1)
  const c = padding === 1 ? sextetAt(text, fullEnd + 2) : 0
  if ((a | b | c) < 0) return null
  if (padding === 2 && (b & 0x0f) !== 0) return null
  if (padding === 1 && (c & 0x03) !== 0) return null
  out[write++] = (a << 2) | (b >>> 4)
  if (padding === 1) out[write] = ((b & 0x0f) << 4) | (c >>> 2)
  return out
}
