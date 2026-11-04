import { WORKLET_JSON_PART_MAX_DEPTH } from '../constants'

function encodesExactly(value: unknown, depth: number): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0)
    case 'object':
      break
    default:
      return false
  }
  if (value === null) return true
  if (depth >= WORKLET_JSON_PART_MAX_DEPTH) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype === Array.prototype) {
    const items = value as readonly unknown[]
    for (let index = 0; index < items.length; index++) {
      if (!(index in items) || !encodesExactly(items[index], depth + 1)) return false
    }
    return true
  }
  if (prototype !== Object.prototype && prototype !== null) return false
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!encodesExactly(record[key], depth + 1)) return false
  }
  return true
}

export function jsonOfPart(items: readonly unknown[]): string | null {
  for (const item of items) {
    if (!encodesExactly(item, 1)) return null
  }
  return JSON.stringify(items)
}
