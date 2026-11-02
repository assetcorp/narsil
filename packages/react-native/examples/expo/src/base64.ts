const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const PADDING = '='

const VALUES = new Map<string, number>()
for (let index = 0; index < ALPHABET.length; index++) VALUES.set(ALPHABET.charAt(index), index)

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const group = (first << 16) | (second << 8) | third
    parts.push(ALPHABET.charAt((group >> 18) & 63), ALPHABET.charAt((group >> 12) & 63))
    parts.push(index + 1 < bytes.length ? ALPHABET.charAt((group >> 6) & 63) : PADDING)
    parts.push(index + 2 < bytes.length ? ALPHABET.charAt(group & 63) : PADDING)
  }
  return parts.join('')
}

function valueAt(text: string, index: number): number {
  const value = VALUES.get(text.charAt(index))
  if (value === undefined) throw new Error(`Base64 text holds an invalid character at ${index}`)
  return value
}

export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Error('Base64 text must come in groups of four characters')
  const padding = text.endsWith('==') ? 2 : text.endsWith(PADDING) ? 1 : 0
  const bytes = new Uint8Array((text.length / 4) * 3 - padding)
  let written = 0
  for (let index = 0; index < text.length; index += 4) {
    const third = text.charAt(index + 2) === PADDING ? 0 : valueAt(text, index + 2)
    const fourth = text.charAt(index + 3) === PADDING ? 0 : valueAt(text, index + 3)
    const group = (valueAt(text, index) << 18) | (valueAt(text, index + 1) << 12) | (third << 6) | fourth
    if (written < bytes.length) bytes[written++] = (group >> 16) & 255
    if (written < bytes.length) bytes[written++] = (group >> 8) & 255
    if (written < bytes.length) bytes[written++] = group & 255
  }
  return bytes
}
