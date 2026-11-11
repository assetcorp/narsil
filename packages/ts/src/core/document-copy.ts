const NOT_PLAIN: unique symbol = Symbol('not plain')

type Copied = unknown

interface CopyState {
  first: object | undefined
  seen: Set<object> | undefined
}

function firstVisit(value: object, state: CopyState): boolean {
  if (state.first === undefined) {
    state.first = value
    return true
  }
  if (state.seen === undefined) state.seen = new Set([state.first])
  if (state.seen.has(value)) return false
  state.seen.add(value)
  return true
}

function holdsIndexesOnly(source: readonly unknown[]): boolean {
  const length = source.length
  if (length === 0) return Object.keys(source).length === 0
  const keys = Object.keys(source)
  return keys.length === length && keys[length - 1] === String(length - 1)
}

function copyArray(source: readonly unknown[], state: CopyState): Copied {
  if (!holdsIndexesOnly(source)) return NOT_PLAIN
  const copy: unknown[] = []
  for (let index = 0; index < source.length; index++) {
    const value = copyValue(source[index], state)
    if (value === NOT_PLAIN) return NOT_PLAIN
    copy.push(value)
  }
  return copy
}

function copyRecord(source: Record<string, unknown>, state: CopyState): Copied {
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(source, key)) continue
    const value = copyValue(source[key], state)
    if (value === NOT_PLAIN) return NOT_PLAIN
    if (key === '__proto__') {
      Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true })
    } else {
      copy[key] = value
    }
  }
  return copy
}

function copyValue(value: unknown, state: CopyState): Copied {
  if (typeof value === 'function' || typeof value === 'symbol') return NOT_PLAIN
  if (typeof value !== 'object' || value === null) return value
  if (!firstVisit(value, state)) return NOT_PLAIN
  const prototype: unknown = Object.getPrototypeOf(value)
  if (Array.isArray(value)) return prototype === Array.prototype ? copyArray(value, state) : NOT_PLAIN
  if (prototype !== Object.prototype && prototype !== null) return NOT_PLAIN
  return copyRecord(value as Record<string, unknown>, state)
}

export function copyStoredValue(value: unknown): unknown {
  const copy = copyValue(value, { first: undefined, seen: undefined })
  return copy === NOT_PLAIN ? structuredClone(value) : copy
}
