import { ErrorCodes, NarsilError } from '../../errors'

export function corrupt(message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Invalid keyword segment: ${message}`, details)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)
}

export function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) corrupt(`${name} must be a map`)
  return value
}

export function requireList(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) corrupt(`${name} must be a list`)
  return value
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') corrupt(`${name} must be a string`)
  return value
}

export function requireStrings(value: unknown, name: string): string[] {
  const list = requireList(value, name)
  for (const item of list) {
    if (typeof item !== 'string') corrupt(`${name} must hold strings alone`)
  }
  return list as string[]
}

export function requireBytes(value: unknown, name: string, width: number): Uint8Array {
  if (!(value instanceof Uint8Array)) corrupt(`${name} must be bytes`)
  if (value.byteLength % width !== 0) {
    corrupt(`${name} holds ${value.byteLength} bytes, which is not a whole number of ${width}-byte values`, {
      field: name,
    })
  }
  return value
}

export function requireBytesOrNil(value: unknown, name: string, width: number): Uint8Array | null {
  if (value === null || value === undefined) return null
  return requireBytes(value, name, width)
}

export function requireUint32(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    corrupt(`${name} must be a uint32`)
  }
  return value
}

export function requireCount(found: number, expected: number, name: string): void {
  if (found === expected) return
  corrupt(`${name} holds ${found} values where the segment needs ${expected}`, { field: name, found, expected })
}
