import type { NodeRegistration } from '../types'

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

export function registrationsMatch(left: NodeRegistration, right: NodeRegistration): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
