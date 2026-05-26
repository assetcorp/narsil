export const SCALAR_FIELD_TYPES = new Set<string>([
  'string',
  'number',
  'boolean',
  'enum',
  'geopoint',
  'string[]',
  'number[]',
  'boolean[]',
  'enum[]',
])

export const VECTOR_PATTERN = /^vector\[(\d+)]$/

export const RESERVED_ROOT_FIELDS = new Set(['id'])

export const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export const MAX_NESTING_DEPTH = 4

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
