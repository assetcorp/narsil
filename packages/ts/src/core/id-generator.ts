export function generateId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  const now = Date.now()
  bytes[0] = Math.floor(now / 2 ** 40)
  bytes[1] = Math.floor(now / 2 ** 32) % 256
  bytes[2] = Math.floor(now / 2 ** 24) % 256
  bytes[3] = Math.floor(now / 2 ** 16) % 256
  bytes[4] = Math.floor(now / 2 ** 8) % 256
  bytes[5] = now % 256

  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
