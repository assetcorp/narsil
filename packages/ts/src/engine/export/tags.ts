import { ErrorCodes, NarsilError } from '../../errors'
import { MAX_DOCUMENT_NESTING_DEPTH } from '../../schema/constants'
import { decodeExactBase64 } from '../../serialization/base64'

export const TAG_PREFIX = '$'
export const DATE_TAG = '$date'
export const BYTES_TAG = '$bytes'
export const NUMBER_TAG = '$number'
export const OBJECT_TAG = '$object'

export const MILLISECONDS_PER_SECOND = 1_000
export const NANOSECONDS_PER_MILLISECOND = 1_000_000
const MAX_NANOSECONDS = 999_999_999
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000
const ESCAPED_TAG_PREFIX = '\\u0024'

const NON_FINITE_NUMBERS: ReadonlyMap<string, number> = new Map([
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
])

function refuse(path: string, reason: string): never {
  throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Field "${path === '' ? '(document)' : path}" ${reason}`, {
    field: path,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function startsWithTagPrefix(key: string): boolean {
  return key.startsWith(TAG_PREFIX)
}

function soleTagKey(record: Record<string, unknown>): string | null {
  let sole: string | null = null
  for (const key of Object.keys(record)) {
    if (sole !== null) return null
    sole = key
  }
  return sole !== null && startsWithTagPrefix(sole) ? sole : null
}

function dateOf(value: unknown, path: string): Date {
  if (!Array.isArray(value) || value.length !== 2)
    refuse(path, `holds a "${DATE_TAG}" tag other than [seconds, nanoseconds]`)
  const seconds: unknown = value[0]
  const nanoseconds: unknown = value[1]
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds)) {
    refuse(
      path,
      `holds a "${DATE_TAG}" tag whose seconds are not an integer from -${Number.MAX_SAFE_INTEGER} to ${Number.MAX_SAFE_INTEGER}`,
    )
  }
  if (
    typeof nanoseconds !== 'number' ||
    !Number.isInteger(nanoseconds) ||
    nanoseconds < 0 ||
    nanoseconds > MAX_NANOSECONDS
  ) {
    refuse(path, `holds a "${DATE_TAG}" tag whose nanoseconds are not an integer from 0 to ${MAX_NANOSECONDS}`)
  }
  const milliseconds = seconds * MILLISECONDS_PER_SECOND + nanoseconds / NANOSECONDS_PER_MILLISECOND
  if (Math.abs(milliseconds) > MAX_DATE_MILLISECONDS)
    refuse(path, `holds a "${DATE_TAG}" tag outside the range of a date`)
  return new Date(milliseconds)
}

function bytesOf(value: unknown, path: string): Uint8Array {
  const bytes = typeof value === 'string' ? decodeExactBase64(value) : null
  if (bytes === null) refuse(path, `holds a "${BYTES_TAG}" tag whose text is not padded base64`)
  return bytes
}

function numberOf(value: unknown, path: string): number {
  const number = typeof value === 'string' ? NON_FINITE_NUMBERS.get(value) : undefined
  if (number === undefined) refuse(path, `holds a "${NUMBER_TAG}" tag other than "NaN", "Infinity", or "-Infinity"`)
  return number
}

function requireDepth(path: string, depth: number): void {
  if (depth >= MAX_DOCUMENT_NESTING_DEPTH) refuse(path, `nests deeper than ${MAX_DOCUMENT_NESTING_DEPTH} levels`)
}

function untagMap(record: Record<string, unknown>, path: string, depth: number): Record<string, unknown> {
  requireDepth(path, depth)
  for (const key of Object.keys(record)) {
    record[key] = untag(record[key], path === '' ? key : `${path}.${key}`, depth + 1)
  }
  return record
}

function untagList(list: unknown[], path: string, depth: number): unknown[] {
  requireDepth(path, depth)
  for (let at = 0; at < list.length; at++) list[at] = untag(list[at], `${path}[${at}]`, depth + 1)
  return list
}

function untagTag(tag: string, value: unknown, path: string, depth: number): unknown {
  switch (tag) {
    case DATE_TAG:
      return dateOf(value, path)
    case BYTES_TAG:
      return bytesOf(value, path)
    case NUMBER_TAG:
      return numberOf(value, path)
    case OBJECT_TAG:
      if (!isRecord(value)) refuse(path, `holds an "${OBJECT_TAG}" tag whose value is not an object`)
      return untagMap(value, path, depth)
    default:
      return refuse(path, `holds an object whose only key, "${tag}", names no tag`)
  }
}

function untag(value: unknown, path: string, depth: number): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return untagList(value, path, depth)
  const record = value as Record<string, unknown>
  const tag = soleTagKey(record)
  return tag === null ? untagMap(record, path, depth) : untagTag(tag, record[tag], path, depth)
}

export function untagDocumentLine(text: string, parsed: Record<string, unknown>): Record<string, unknown> {
  if (!text.includes(`"${TAG_PREFIX}`) && !text.includes(ESCAPED_TAG_PREFIX)) return parsed
  return untagMap(parsed, '', 0)
}
