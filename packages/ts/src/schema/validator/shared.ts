export const VECTOR_PATTERN = /^vector\[(\d+)]$/

export function isGeopointOrVectorType(fieldType: string | undefined): boolean {
  return fieldType === 'geopoint' || (fieldType !== undefined && VECTOR_PATTERN.test(fieldType))
}

export const FIELD_NAME_PATTERN = /^[A-Za-z0-9_]+$/

export const RESERVED_ROOT_FIELDS = new Set(['id'])

export const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
