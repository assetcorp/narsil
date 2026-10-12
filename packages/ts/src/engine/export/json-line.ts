import { ErrorCodes, NarsilError } from '../../errors'

function refuse(path: string, kind: string, docId: string): never {
  throw new NarsilError(
    ErrorCodes.DOC_VALIDATION_FAILED,
    `Document "${docId}" holds ${kind} at "${path || '(document)'}", which a document export cannot carry as JSON`,
    { docId, field: path },
  )
}

function encodeNumber(value: number, path: string, docId: string): string {
  if (!Number.isFinite(value)) refuse(path, String(value), docId)
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}

function encodeValue(value: unknown, path: string, docId: string, parts: string[]): void {
  if (value === null) {
    parts.push('null')
    return
  }
  switch (typeof value) {
    case 'string':
      parts.push(JSON.stringify(value))
      return
    case 'boolean':
      parts.push(value ? 'true' : 'false')
      return
    case 'number':
      parts.push(encodeNumber(value, path, docId))
      return
    case 'object':
      break
    default:
      refuse(path, `a ${typeof value}`, docId)
  }
  if (Array.isArray(value)) {
    parts.push('[')
    for (let at = 0; at < value.length; at++) {
      if (at > 0) parts.push(',')
      encodeValue(value[at], `${path}[${at}]`, docId, parts)
    }
    parts.push(']')
    return
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) refuse(path, 'a value other than a plain object', docId)
  parts.push('{')
  let first = true
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue
    if (!first) parts.push(',')
    first = false
    parts.push(JSON.stringify(key), ':')
    encodeValue(entry, path === '' ? key : `${path}.${key}`, docId, parts)
  }
  parts.push('}')
}

export function encodeExactJson(value: unknown, docId: string): string {
  const parts: string[] = []
  encodeValue(value, '', docId, parts)
  return parts.join('')
}
