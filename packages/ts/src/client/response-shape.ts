import { ClientErrorCodes, NarsilError } from '../errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(path: string, expected: string): NarsilError {
  return new NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, `The answer from ${path} holds no ${expected}`, {
    url: path,
  })
}

/** Reads one array field out of an envelope such as `{ indexes: [...] }`, and
 * fails when the answer holds no such field. */
export function readArray<T>(payload: unknown, key: string, path: string): T[] {
  if (!isRecord(payload) || !Array.isArray(payload[key])) throw malformed(path, `"${key}" array`)
  return payload[key] as T[]
}

/** Reads one number field out of an envelope such as `{ count: 12 }`. */
export function readNumber(payload: unknown, key: string, path: string): number {
  if (!isRecord(payload) || typeof payload[key] !== 'number') throw malformed(path, `"${key}" number`)
  return payload[key]
}

/** Reads one boolean field out of an envelope such as `{ exists: true }`. */
export function readBoolean(payload: unknown, key: string, path: string): boolean {
  if (!isRecord(payload) || typeof payload[key] !== 'boolean') throw malformed(path, `"${key}" flag`)
  return payload[key]
}

/** Reads one string field out of an envelope such as `{ id: "m1" }`. */
export function readString(payload: unknown, key: string, path: string): string {
  if (!isRecord(payload) || typeof payload[key] !== 'string') throw malformed(path, `"${key}" string`)
  return payload[key]
}

/** Reads one object field, which is how the document routes wrap a document. */
export function readObject<T>(payload: unknown, key: string, path: string): T {
  if (!isRecord(payload) || !isRecord(payload[key])) throw malformed(path, `"${key}" object`)
  return payload[key] as T
}

/** Reads a whole answer that comes with no envelope, such as an index's
 * statistics. */
export function readBody<T>(payload: unknown, path: string): T {
  if (!isRecord(payload)) throw malformed(path, 'JSON object')
  return payload as T
}
