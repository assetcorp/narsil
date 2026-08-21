/**
 * Reports whether a decoded value is a plain object, so that a caller may read its fields.
 *
 * A decoder returns `unknown`, and every validator narrows that value with this guard before it reads a single
 * field.
 *
 * @param value - The decoded value.
 * @returns True when the value is a non-null object other than an array.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reports whether a decoded value is an integer a caller may use in arithmetic.
 *
 * The guard rejects `NaN` and both infinities as well as a fractional value, because a sequence number, a term, or a
 * partition id that fails any of those checks would make every comparison against a bound return false.
 *
 * @param value - The decoded value.
 * @returns True when the value is a finite integer.
 */
export function isValidInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}
