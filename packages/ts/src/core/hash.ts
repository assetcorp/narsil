const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

const encoder = new TextEncoder()

export function fnv1a(input: string): number {
  const bytes = encoder.encode(input)
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}
