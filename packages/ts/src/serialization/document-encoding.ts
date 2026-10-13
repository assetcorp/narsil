import { encode } from '@msgpack/msgpack'

function holdsNegativeZero(value: unknown): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const next = pending.pop()
    if (typeof next === 'number') {
      if (Object.is(next, -0)) return true
      continue
    }
    if (next === null || typeof next !== 'object' || ArrayBuffer.isView(next)) continue
    for (const child of Array.isArray(next) ? next : Object.values(next)) pending.push(child)
  }
  return false
}

export function encodeDocument(document: unknown): Uint8Array {
  return encode(document, holdsNegativeZero(document) ? { forceIntegerToFloat: true } : undefined)
}
