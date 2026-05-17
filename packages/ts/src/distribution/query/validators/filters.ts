import type { ErrorCode } from '../../../errors'
import {
  isFiniteNumber,
  isRecord,
  MAX_FILTER_ARRAY_SIZE,
  MAX_FILTER_DEPTH,
  MAX_FILTER_FIELDS,
  MAX_FILTER_STRING_LENGTH,
  SEARCH_INVALID_FILTER,
  throwInvalid,
  validateFieldName,
} from './common'

const COMPARISON_NUMERIC_OPS = ['gt', 'lt', 'gte', 'lte'] as const

const COMPARISON_EQ_OPS = ['eq', 'ne'] as const

const STRING_OPS = ['startsWith', 'endsWith'] as const

const STRING_LIST_OPS = ['in', 'nin'] as const

const ARRAY_LIST_OPS = ['containsAll', 'matchesAny'] as const

const PRESENCE_OPS = ['exists', 'notExists', 'isEmpty', 'isNotEmpty'] as const

const GEO_UNITS = ['km', 'mi', 'm'] as const

function validateScalarPrimitive(value: unknown, fieldLabel: string, errorCode: ErrorCode): number | string | boolean {
  if (typeof value === 'string') {
    if (value.length > MAX_FILTER_STRING_LENGTH) {
      throwInvalid(
        errorCode,
        `Invalid payload: "${fieldLabel}" exceeds maximum length of ${MAX_FILTER_STRING_LENGTH}`,
        {
          length: value.length,
          limit: MAX_FILTER_STRING_LENGTH,
        },
      )
    }
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a finite number`)
    }
    return value
  }
  if (typeof value === 'boolean') {
    return value
  }
  throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a string, finite number, or boolean`)
}

function validateBoundedString(value: unknown, fieldLabel: string, errorCode: ErrorCode): string {
  if (typeof value !== 'string') {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a string`)
  }
  if (value.length > MAX_FILTER_STRING_LENGTH) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum length of ${MAX_FILTER_STRING_LENGTH}`, {
      length: value.length,
      limit: MAX_FILTER_STRING_LENGTH,
    })
  }
  return value
}

function validateNumericOperand(value: unknown, fieldLabel: string, errorCode: ErrorCode): number {
  if (!isFiniteNumber(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a finite number`)
  }
  return value
}

function validateBooleanOperand(value: unknown, fieldLabel: string, errorCode: ErrorCode): boolean {
  if (typeof value !== 'boolean') {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a boolean`)
  }
  return value
}

function validateScalarArray(value: unknown, fieldLabel: string, errorCode: ErrorCode): void {
  if (!Array.isArray(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an array`)
  }
  if (value.length > MAX_FILTER_ARRAY_SIZE) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum length of ${MAX_FILTER_ARRAY_SIZE}`, {
      length: value.length,
      limit: MAX_FILTER_ARRAY_SIZE,
    })
  }
  for (let i = 0; i < value.length; i++) {
    validateScalarPrimitive(value[i], `${fieldLabel}[${i}]`, errorCode)
  }
}

function validateStringList(value: unknown, fieldLabel: string, errorCode: ErrorCode): void {
  if (!Array.isArray(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an array`)
  }
  if (value.length > MAX_FILTER_ARRAY_SIZE) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum length of ${MAX_FILTER_ARRAY_SIZE}`, {
      length: value.length,
      limit: MAX_FILTER_ARRAY_SIZE,
    })
  }
  for (let i = 0; i < value.length; i++) {
    validateBoundedString(value[i], `${fieldLabel}[${i}]`, errorCode)
  }
}

function validateBetween(value: unknown, fieldLabel: string, errorCode: ErrorCode): void {
  if (!Array.isArray(value) || value.length !== 2) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a two-element array`)
  }
  validateNumericOperand(value[0], `${fieldLabel}[0]`, errorCode)
  validateNumericOperand(value[1], `${fieldLabel}[1]`, errorCode)
}

function isKnownLeafKey(key: string): boolean {
  if (COMPARISON_NUMERIC_OPS.includes(key as (typeof COMPARISON_NUMERIC_OPS)[number])) return true
  if (COMPARISON_EQ_OPS.includes(key as (typeof COMPARISON_EQ_OPS)[number])) return true
  if (STRING_OPS.includes(key as (typeof STRING_OPS)[number])) return true
  if (STRING_LIST_OPS.includes(key as (typeof STRING_LIST_OPS)[number])) return true
  if (ARRAY_LIST_OPS.includes(key as (typeof ARRAY_LIST_OPS)[number])) return true
  if (PRESENCE_OPS.includes(key as (typeof PRESENCE_OPS)[number])) return true
  return key === 'between' || key === 'size' || key === 'radius' || key === 'polygon'
}

function validateGeoRadius(value: unknown, fieldLabel: string, errorCode: ErrorCode): void {
  if (!isRecord(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an object`)
  }
  validateNumericOperand(value.lat, `${fieldLabel}.lat`, errorCode)
  validateNumericOperand(value.lon, `${fieldLabel}.lon`, errorCode)
  validateNumericOperand(value.distance, `${fieldLabel}.distance`, errorCode)
  if ((value.distance as number) < 0) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}.distance" must be non-negative`)
  }
  if (!GEO_UNITS.includes(value.unit as (typeof GEO_UNITS)[number])) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}.unit" must be one of: ${GEO_UNITS.join(', ')}`)
  }
  if (value.inside !== undefined) {
    validateBooleanOperand(value.inside, `${fieldLabel}.inside`, errorCode)
  }
  if (value.highPrecision !== undefined) {
    validateBooleanOperand(value.highPrecision, `${fieldLabel}.highPrecision`, errorCode)
  }
}

function validateGeoPolygon(value: unknown, fieldLabel: string, errorCode: ErrorCode): void {
  if (!isRecord(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an object`)
  }
  if (!Array.isArray(value.points)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}.points" must be an array`)
  }
  const points = value.points
  if (points.length > MAX_FILTER_ARRAY_SIZE) {
    throwInvalid(
      errorCode,
      `Invalid payload: "${fieldLabel}.points" exceeds maximum length of ${MAX_FILTER_ARRAY_SIZE}`,
      { length: points.length, limit: MAX_FILTER_ARRAY_SIZE },
    )
  }
  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    if (!isRecord(point)) {
      throwInvalid(errorCode, `Invalid payload: "${fieldLabel}.points[${i}]" must be an object`)
    }
    validateNumericOperand(point.lat, `${fieldLabel}.points[${i}].lat`, errorCode)
    validateNumericOperand(point.lon, `${fieldLabel}.points[${i}].lon`, errorCode)
  }
  if (value.inside !== undefined) {
    validateBooleanOperand(value.inside, `${fieldLabel}.inside`, errorCode)
  }
}

function validateLeafOperator(opKey: string, opValue: unknown, leafLabel: string, errorCode: ErrorCode): void {
  const opLabel = `${leafLabel}.${opKey}`
  if (opKey === 'gt' || opKey === 'lt' || opKey === 'gte' || opKey === 'lte') {
    validateNumericOperand(opValue, opLabel, errorCode)
    return
  }
  if (opKey === 'eq' || opKey === 'ne') {
    validateScalarPrimitive(opValue, opLabel, errorCode)
    return
  }
  if (opKey === 'between') {
    validateBetween(opValue, opLabel, errorCode)
    return
  }
  if (opKey === 'startsWith' || opKey === 'endsWith') {
    validateBoundedString(opValue, opLabel, errorCode)
    return
  }
  if (opKey === 'in' || opKey === 'nin') {
    validateStringList(opValue, opLabel, errorCode)
    return
  }
  if (opKey === 'containsAll' || opKey === 'matchesAny') {
    validateScalarArray(opValue, opLabel, errorCode)
    return
  }
  if (opKey === 'exists' || opKey === 'notExists' || opKey === 'isEmpty' || opKey === 'isNotEmpty') {
    validateBooleanOperand(opValue, opLabel, errorCode)
    return
  }
  if (opKey === 'size') {
    if (!isRecord(opValue)) {
      throwInvalid(errorCode, `Invalid payload: "${opLabel}" must be an object`)
    }
    for (const [innerKey, innerValue] of Object.entries(opValue)) {
      if (!isKnownLeafKey(innerKey)) {
        throwInvalid(errorCode, `Invalid payload: "${opLabel}" contains unsupported operator "${innerKey}"`)
      }
      validateLeafOperator(innerKey, innerValue, opLabel, errorCode)
    }
    return
  }
  if (opKey === 'radius') {
    validateGeoRadius(opValue, opLabel, errorCode)
    return
  }
  if (opKey === 'polygon') {
    validateGeoPolygon(opValue, opLabel, errorCode)
    return
  }
  throwInvalid(errorCode, `Invalid payload: "${leafLabel}" contains unsupported operator "${opKey}"`)
}

function validateFieldFilter(value: unknown, fieldLabel: string, errorCode: ErrorCode): void {
  if (!isRecord(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an object`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must define at least one operator`)
  }
  if (entries.length > MAX_FILTER_FIELDS) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum operator count of ${MAX_FILTER_FIELDS}`, {
      length: entries.length,
      limit: MAX_FILTER_FIELDS,
    })
  }
  for (const [opKey, opValue] of entries) {
    validateLeafOperator(opKey, opValue, fieldLabel, errorCode)
  }
}

function validateFieldsRecord(value: unknown, fieldLabel: string, errorCode: ErrorCode): void {
  if (!isRecord(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an object`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must contain at least one field`)
  }
  if (entries.length > MAX_FILTER_FIELDS) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum field count of ${MAX_FILTER_FIELDS}`, {
      length: entries.length,
      limit: MAX_FILTER_FIELDS,
    })
  }
  for (const [fieldName, fieldFilter] of entries) {
    validateFieldName(fieldName, `${fieldLabel}<key>`, errorCode)
    validateFieldFilter(fieldFilter, `${fieldLabel}.${fieldName}`, errorCode)
  }
}

function validateFilterArray(value: unknown, fieldLabel: string, errorCode: ErrorCode, depth: number): void {
  if (!Array.isArray(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an array`)
  }
  if (value.length === 0) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must contain at least one expression`)
  }
  if (value.length > MAX_FILTER_FIELDS) {
    throwInvalid(
      errorCode,
      `Invalid payload: "${fieldLabel}" exceeds maximum expression count of ${MAX_FILTER_FIELDS}`,
      { length: value.length, limit: MAX_FILTER_FIELDS },
    )
  }
  for (let i = 0; i < value.length; i++) {
    validateFilterExpression(value[i], `${fieldLabel}[${i}]`, errorCode, depth + 1)
  }
}

export function validateFilterExpression(
  value: unknown,
  fieldLabel: string,
  errorCode: ErrorCode = SEARCH_INVALID_FILTER,
  depth: number = 0,
): void {
  if (depth > MAX_FILTER_DEPTH) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum nesting depth of ${MAX_FILTER_DEPTH}`, {
      depth,
      limit: MAX_FILTER_DEPTH,
    })
  }
  if (!isRecord(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an object`)
  }
  const knownKeys = ['fields', 'and', 'or', 'not']
  const entries = Object.entries(value)
  if (entries.length === 0) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must contain at least one clause`)
  }
  for (const [key, clauseValue] of entries) {
    if (!knownKeys.includes(key)) {
      throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" contains unsupported clause "${key}"`)
    }
    if (key === 'fields') {
      validateFieldsRecord(clauseValue, `${fieldLabel}.fields`, errorCode)
    } else if (key === 'and') {
      validateFilterArray(clauseValue, `${fieldLabel}.and`, errorCode, depth)
    } else if (key === 'or') {
      validateFilterArray(clauseValue, `${fieldLabel}.or`, errorCode, depth)
    } else if (key === 'not') {
      validateFilterExpression(clauseValue, `${fieldLabel}.not`, errorCode, depth + 1)
    }
  }
}
