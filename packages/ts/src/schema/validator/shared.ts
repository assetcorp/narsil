export const SORTABLE_TEXT_FIELD_TYPE = 'string:sortable'

export const SCALAR_FIELD_TYPES = new Set<string>([
  'string',
  SORTABLE_TEXT_FIELD_TYPE,
  'number',
  'boolean',
  'enum',
  'geopoint',
  'string[]',
  'number[]',
  'boolean[]',
  'enum[]',
])

export function isTextFieldType(fieldType: string): boolean {
  return fieldType === 'string' || fieldType === SORTABLE_TEXT_FIELD_TYPE
}

export const VECTOR_PATTERN = /^vector\[(\d+)]$/

export const FIELD_NAME_PATTERN = /^[A-Za-z0-9_]+$/

export const RESERVED_ROOT_FIELDS = new Set(['id'])

export const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
