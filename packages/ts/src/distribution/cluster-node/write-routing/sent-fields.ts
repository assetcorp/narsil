import type { AnyDocument } from '../../../types/schema'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value)
}

function numbersOf(value: unknown): ArrayLike<number> | null {
  if (value instanceof Float32Array || value instanceof Float64Array) return value
  if (Array.isArray(value) && value.every(element => typeof element === 'number')) return value
  return null
}

function sameNumber(sent: number, stored: number): boolean {
  return sent === stored || (Number.isNaN(sent) && Number.isNaN(stored))
}

function sameVector(sent: ArrayLike<number>, stored: ArrayLike<number>): boolean {
  if (sent.length !== stored.length) return false
  for (let position = 0; position < sent.length; position++) {
    const sentValue = sent[position]
    const storedValue = stored[position]
    if (!sameNumber(sentValue, storedValue) && !sameNumber(Math.fround(sentValue), Math.fround(storedValue))) {
      return false
    }
  }
  return true
}

function fieldPath(parent: string, key: string): string {
  return parent.length === 0 ? key : `${parent}.${key}`
}

function matchesSent(sent: unknown, stored: unknown, path: string, derivedFields: ReadonlySet<string>): boolean {
  const sentNumbers = numbersOf(sent)
  const storedNumbers = numbersOf(stored)
  if (sentNumbers !== null && storedNumbers !== null) return sameVector(sentNumbers, storedNumbers)
  if (Array.isArray(sent)) {
    if (!Array.isArray(stored) || sent.length !== stored.length) return false
    return sent.every((element, position) => matchesSent(element, stored[position], path, new Set()))
  }
  if (isRecord(sent)) {
    if (!isRecord(stored)) return false
    for (const [key, value] of Object.entries(sent)) {
      if (value === undefined) continue
      if (!matchesSent(value, stored[key], fieldPath(path, key), derivedFields)) return false
    }
    for (const [key, value] of Object.entries(stored)) {
      if (value === undefined || sent[key] !== undefined) continue
      if (!derivedFields.has(fieldPath(path, key))) return false
    }
    return true
  }
  if (typeof sent === 'number' && typeof stored === 'number') return sameNumber(sent, stored)
  return sent === stored
}

export function storedCopyMatchesSent(
  sent: AnyDocument,
  stored: AnyDocument,
  derivedFields: ReadonlySet<string>,
): boolean {
  return matchesSent(sent, stored, '', derivedFields)
}
