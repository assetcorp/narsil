export class DecodedTimestamp {
  constructor(
    readonly seconds: number,
    readonly nanoseconds: number,
  ) {}
}

export type Decoded =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | DecodedTimestamp
  | Decoded[]
  | Map<string, Decoded>

export class FormError extends Error {}

export function isDecodedMap(value: Decoded | undefined): value is Map<string, Decoded> {
  return value instanceof Map
}

export function mapOf(value: Decoded | undefined, what: string): Map<string, Decoded> {
  if (!isDecodedMap(value)) throw new FormError(`${what} is not a map`)
  return value
}

export function listOf(value: Decoded | undefined, what: string): Decoded[] {
  if (!Array.isArray(value)) throw new FormError(`${what} is not a list`)
  return value
}

export function bytesOf(value: Decoded | undefined, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new FormError(`${what} is not a binary value`)
  return value
}

export function stringOf(value: Decoded | undefined, what: string): string {
  if (typeof value !== 'string') throw new FormError(`${what} is not a string`)
  return value
}

export function numberOf(value: Decoded | undefined, what: string): number {
  if (typeof value !== 'number') throw new FormError(`${what} is not a number`)
  return value
}

export function stringsOf(value: Decoded | undefined, what: string): string[] {
  return listOf(value, what).map((item, at) => stringOf(item, `${what}[${at}]`))
}

export function fieldOf(map: Map<string, Decoded>, key: string, what: string): Decoded {
  const value = map.get(key)
  if (value === undefined) throw new FormError(`${what} has no ${key}`)
  return value
}
