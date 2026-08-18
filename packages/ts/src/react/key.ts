import { ErrorCodes, NarsilError } from '../errors'

const MAX_DEPTH = 32

function refuse(reason: string): NarsilError {
  return new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `A hook argument ${reason}, so the React bindings cannot tell one request from another`,
  )
}

function writeList(values: ArrayLike<unknown>, out: string[], depth: number, seen: object[]): void {
  out.push('[')
  for (let index = 0; index < values.length; index++) {
    if (index > 0) out.push(',')
    write(values[index], out, depth, seen)
  }
  out.push(']')
}

function writeObject(value: object, out: string[], depth: number, seen: object[]): void {
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  out.push('{')
  let written = 0
  for (const key of keys) {
    const held = record[key]
    if (held === undefined) continue
    if (written > 0) out.push(',')
    out.push(JSON.stringify(key), ':')
    write(held, out, depth, seen)
    written++
  }
  out.push('}')
}

function write(value: unknown, out: string[], depth: number, seen: object[]): void {
  if (value === null) {
    out.push('null')
    return
  }
  switch (typeof value) {
    case 'undefined':
      out.push('undefined')
      return
    case 'string':
      out.push(JSON.stringify(value))
      return
    case 'number':
    case 'boolean':
      out.push(String(value))
      return
    case 'bigint':
      out.push(`${value}n`)
      return
    case 'function':
    case 'symbol':
      throw refuse(`is a ${typeof value}, which carries no value a request depends on`)
    default:
      break
  }

  if (depth >= MAX_DEPTH) throw refuse(`nests deeper than ${MAX_DEPTH} levels`)
  const held = value as object
  if (seen.includes(held)) throw refuse('holds a reference back to itself')
  seen.push(held)

  const custom = (held as { toJSON?: unknown }).toJSON
  if (typeof custom === 'function') {
    write((custom as () => unknown).call(held), out, depth + 1, seen)
  } else if (Array.isArray(held)) {
    writeList(held, out, depth + 1, seen)
  } else if (ArrayBuffer.isView(held) && !(held instanceof DataView)) {
    writeList(held as unknown as ArrayLike<number>, out, depth + 1, seen)
  } else {
    writeObject(held, out, depth + 1, seen)
  }

  seen.pop()
}

/**
 * Builds the string that identifies one request, so that two components asking
 * for the same thing share a single answer.
 *
 * It reads the arguments the way the client sends them: object keys come out in
 * a fixed order, a field set to `undefined` reads the same as an absent one, a
 * `toJSON` method decides its own value, and a typed array reads as its numbers.
 *
 * @param parts - These are the method name and the arguments the hook was
 * called with.
 * @returns Equal arguments give an equal string, and different arguments give a
 * different one.
 * @throws A `NarsilError` with `CONFIG_INVALID` for an argument holding a
 * function, a symbol, a reference back to itself, or more than 32 levels of
 * nesting.
 */
export function hashKey(parts: readonly unknown[]): string {
  const out: string[] = []
  writeList(parts, out, 0, [])
  return out.join('')
}
