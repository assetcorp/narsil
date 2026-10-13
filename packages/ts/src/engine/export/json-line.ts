import { ErrorCodes, NarsilError } from '../../errors'
import { encodeBase64 } from '../../serialization/base64'
import {
  BYTES_TAG,
  DATE_TAG,
  MILLISECONDS_PER_SECOND,
  NANOSECONDS_PER_MILLISECOND,
  NUMBER_TAG,
  OBJECT_TAG,
  startsWithTagPrefix,
} from './tags'

interface JsonLineTarget {
  docId: string
  tagged: boolean
  parts: string[]
}

function refuse(path: string, kind: string, docId: string): never {
  throw new NarsilError(
    ErrorCodes.DOC_VALIDATION_FAILED,
    `Document "${docId}" holds ${kind} at "${path || '(document)'}", which a document export cannot carry as JSON`,
    { docId, field: path },
  )
}

function encodeNumber(value: number, path: string, target: JsonLineTarget): string {
  if (Number.isFinite(value)) return Object.is(value, -0) ? '-0' : JSON.stringify(value)
  if (!target.tagged) refuse(path, String(value), target.docId)
  return `{"${NUMBER_TAG}":"${String(value)}"}`
}

function encodeDate(value: Date, path: string, target: JsonLineTarget): string {
  const milliseconds = value.getTime()
  if (!target.tagged || Number.isNaN(milliseconds)) refuse(path, 'a date', target.docId)
  const seconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND)
  const nanoseconds = (milliseconds - seconds * MILLISECONDS_PER_SECOND) * NANOSECONDS_PER_MILLISECOND
  return `{"${DATE_TAG}":[${seconds},${nanoseconds}]}`
}

function encodeBytes(value: Uint8Array, path: string, target: JsonLineTarget): string {
  if (!target.tagged) refuse(path, 'bytes', target.docId)
  return `{"${BYTES_TAG}":"${encodeBase64(value)}"}`
}

function encodeList(value: unknown[], path: string, target: JsonLineTarget): void {
  target.parts.push('[')
  for (let at = 0; at < value.length; at++) {
    if (at > 0) target.parts.push(',')
    encodeValue(value[at], `${path}[${at}]`, target)
  }
  target.parts.push(']')
}

function encodeMap(value: object, path: string, target: JsonLineTarget): void {
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) refuse(path, 'a value other than a plain object', target.docId)
  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
  const wrapped = target.tagged && entries.length === 1 && startsWithTagPrefix(entries[0][0])
  target.parts.push(wrapped ? `{"${OBJECT_TAG}":{` : '{')
  for (let at = 0; at < entries.length; at++) {
    const [key, entry] = entries[at]
    if (at > 0) target.parts.push(',')
    target.parts.push(JSON.stringify(key), ':')
    encodeValue(entry, path === '' ? key : `${path}.${key}`, target)
  }
  target.parts.push(wrapped ? '}}' : '}')
}

function encodeValue(value: unknown, path: string, target: JsonLineTarget): void {
  if (value === null) {
    target.parts.push('null')
    return
  }
  switch (typeof value) {
    case 'string':
      target.parts.push(JSON.stringify(value))
      return
    case 'boolean':
      target.parts.push(value ? 'true' : 'false')
      return
    case 'number':
      target.parts.push(encodeNumber(value, path, target))
      return
    case 'object':
      break
    default:
      refuse(path, `a ${typeof value}`, target.docId)
  }
  if (Array.isArray(value)) encodeList(value, path, target)
  else if (value instanceof Date) target.parts.push(encodeDate(value, path, target))
  else if (value instanceof Uint8Array) target.parts.push(encodeBytes(value, path, target))
  else encodeMap(value, path, target)
}

export function encodeExactJson(value: unknown, docId: string): string {
  const target: JsonLineTarget = { docId, tagged: false, parts: [] }
  encodeValue(value, '', target)
  return target.parts.join('')
}

export function encodeDocumentJson(document: Record<string, unknown>, docId: string): string {
  const target: JsonLineTarget = { docId, tagged: true, parts: [] }
  encodeValue(document, '', target)
  return target.parts.join('')
}
