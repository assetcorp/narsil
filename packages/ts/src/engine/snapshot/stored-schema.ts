import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { SchemaDefinition } from '../../types/schema'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function conflictingStoredPath(path: string): NarsilError {
  return new NarsilError(
    ErrorCodes.SCHEMA_INVALID_TYPE,
    `Field path "${path}" is declared both as a field and as an object of fields`,
    { path },
  )
}

function defineOwn(level: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(level, key, { value, enumerable: true, writable: true, configurable: true })
}

function placeStoredField(nested: Record<string, unknown>, path: string, type: unknown): void {
  const segments = path.split('.')
  let level = nested
  for (let at = 0; at < segments.length; at++) {
    const segment = segments[at]
    const held = Object.hasOwn(level, segment) ? level[segment] : undefined
    if (at === segments.length - 1) {
      if (held !== undefined) throw conflictingStoredPath(path)
      defineOwn(level, segment, type)
      return
    }
    if (held === undefined) {
      const child: Record<string, unknown> = {}
      defineOwn(level, segment, child)
      level = child
    } else if (isRecord(held)) {
      level = held
    } else {
      throw conflictingStoredPath(segments.slice(0, at + 1).join('.'))
    }
  }
}

function placeStoredFields(nested: Record<string, unknown>, stored: Record<string, unknown>, prefix: string): void {
  for (const [key, type] of Object.entries(stored)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isRecord(type)) {
      placeStoredFields(nested, type, path)
    } else {
      placeStoredField(nested, path, type)
    }
  }
}

export function nestedSchemaOf(stored: unknown): SchemaDefinition {
  if (!isRecord(stored)) return stored as SchemaDefinition
  const nested: Record<string, unknown> = {}
  placeStoredFields(nested, stored, '')
  return nested as SchemaDefinition
}
