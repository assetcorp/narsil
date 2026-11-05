import { type Decoded, DecodedTimestamp, FormError } from './decoded'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

const TAG_PREFIX = '$'
const NANOSECONDS_LIMIT = 999_999_999
const NON_FINITE = new Map<string, number>([
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
])

export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function soleTagKey(value: JsonObject): string | null {
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0].startsWith(TAG_PREFIX) ? keys[0] : null
}

export function taggedNumber(value: number): Json {
  return Number.isFinite(value) ? value : { $number: String(value) }
}

export function tagged(value: Decoded): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return taggedNumber(value)
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  if (value instanceof DecodedTimestamp) return { $date: [value.seconds, value.nanoseconds] }
  if (Array.isArray(value)) return value.map(tagged)
  const object: JsonObject = {}
  for (const [key, entry] of value) object[key] = tagged(entry)
  return soleTagKey(object) === null ? object : { $object: object }
}

function untaggedMap(object: JsonObject): Map<string, Decoded> {
  const map = new Map<string, Decoded>()
  for (const [key, entry] of Object.entries(object)) map.set(key, untagged(entry))
  return map
}

function untaggedTag(tag: string, value: Json): Decoded {
  if (tag === '$number' && typeof value === 'string') {
    const number = NON_FINITE.get(value)
    if (number !== undefined) return number
  }
  if (tag === '$bytes' && typeof value === 'string') {
    const bytes = new Uint8Array(Buffer.from(value, 'base64'))
    if (Buffer.from(bytes).toString('base64') === value) return bytes
  }
  if (tag === '$date' && Array.isArray(value) && value.length === 2) {
    const [seconds, nanoseconds] = value
    if (
      typeof seconds === 'number' &&
      Number.isSafeInteger(seconds) &&
      typeof nanoseconds === 'number' &&
      Number.isInteger(nanoseconds) &&
      nanoseconds >= 0 &&
      nanoseconds <= NANOSECONDS_LIMIT
    ) {
      return new DecodedTimestamp(seconds, nanoseconds)
    }
  }
  if (tag === '$object' && isJsonObject(value)) return untaggedMap(value)
  throw new FormError(`the tag ${tag} holds a value that the tag does not allow`)
}

export function untagged(value: Json): Decoded {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(untagged)
  const tag = soleTagKey(value)
  return tag === null ? untaggedMap(value) : untaggedTag(tag, value[tag])
}

export interface ContentRules {
  signedZero: boolean
}

const MESSAGEPACK_RULES: ContentRules = { signedZero: false }

function describe(value: Json | undefined): string {
  return value === undefined ? 'nothing' : JSON.stringify(value)
}

export function contentDifference(
  expected: Json | undefined,
  actual: Json | undefined,
  path = '',
  rules: ContentRules = MESSAGEPACK_RULES,
): string | null {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (expected === actual && (!rules.signedZero || Object.is(expected, actual))) return null
    return `${path || '(root)'}: expected ${describe(expected)}, found ${describe(actual)}`
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path || '(root)'}: expected ${expected.length} items, found ${actual.length}`
    }
    for (let at = 0; at < expected.length; at++) {
      const difference = contentDifference(expected[at], actual[at], `${path}[${at}]`, rules)
      if (difference !== null) return difference
    }
    return null
  }
  if (isJsonObject(expected) && isJsonObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const key of [...keys].sort()) {
      const difference = contentDifference(expected[key], actual[key], path === '' ? key : `${path}.${key}`, rules)
      if (difference !== null) return difference
    }
    return null
  }
  if (expected === actual) return null
  return `${path || '(root)'}: expected ${describe(expected)}, found ${describe(actual)}`
}
