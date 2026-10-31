import { MAX_BM25_B, MAX_BM25_K1 } from '../core/constants'
import { type ErrorCode, ErrorCodes, NarsilError } from '../errors'
import { flattenSchema } from '../schema/validator'
import { isWordIndexedFieldType } from '../schema/validator/field-type'
import { isPlainObject } from '../schema/validator/shared'
import type { BM25FieldParams, BM25Params, SchemaDefinition } from '../types/schema'
import { BM25_DISPLAYED_NAME_LENGTH as DISPLAYED_NAME_LENGTH } from './constants'

export type BM25ValueRanges = 'settable' | 'stored'

const BM25_KEYS: ReadonlySet<string> = new Set(['k1', 'b', 'fields'])
const BM25_FIELD_KEYS: ReadonlySet<string> = new Set(['k1', 'b'])

function displayed(value: unknown): string {
  if (typeof value === 'string') return `"${value.slice(0, DISPLAYED_NAME_LENGTH)}"`
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  return `a value of type ${typeof value}`
}

function requireValue(label: string, value: unknown, maximum: number, ranges: BM25ValueRanges): void {
  if (value === undefined) return
  const usable =
    typeof value === 'number' && Number.isFinite(value) && (ranges === 'stored' || (value >= 0 && value <= maximum))
  if (usable) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `${label} must be a finite number from 0 to ${maximum}, and this request sets ${displayed(value)}`,
    { parameter: label },
  )
}

function requireKnownKeys(label: string, value: Record<string, unknown>, known: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (known.has(key)) continue
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `${label} takes ${[...known].join(', ')}, and this request sets ${displayed(key)}`,
      { parameter: label },
    )
  }
}

function requireFieldPair(name: string, pair: unknown, ranges: BM25ValueRanges): void {
  const label = `bm25.fields.${name.slice(0, DISPLAYED_NAME_LENGTH)}`
  if (!isPlainObject(pair)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `${label} must be an object that sets k1 or b`, {
      parameter: label,
    })
  }
  requireKnownKeys(label, pair, BM25_FIELD_KEYS)
  requireValue(`${label}.k1`, pair.k1, MAX_BM25_K1, ranges)
  requireValue(`${label}.b`, pair.b, MAX_BM25_B, ranges)
}

function requireScoredField(
  name: string,
  flatSchema: Readonly<Record<string, unknown>>,
  unknownFieldCode: ErrorCode,
): void {
  const fieldType = Object.hasOwn(flatSchema, name) ? flatSchema[name] : undefined
  if (typeof fieldType === 'string' && isWordIndexedFieldType(fieldType)) return
  throw new NarsilError(
    unknownFieldCode,
    fieldType === undefined
      ? `BM25 parameters apply to a text field that the schema declares, and the schema declares no field ${displayed(name)}`
      : `BM25 parameters apply to a text field alone, and the schema declares field ${displayed(name)} as ${displayed(fieldType)}`,
    { field: name.slice(0, DISPLAYED_NAME_LENGTH) },
  )
}

function fieldsOfCheckedSetting(raw: unknown, ranges: BM25ValueRanges): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'bm25 must be an object that sets k1, b, or fields')
  }
  requireKnownKeys('bm25', raw, BM25_KEYS)
  requireValue('bm25.k1', raw.k1, MAX_BM25_K1, ranges)
  requireValue('bm25.b', raw.b, MAX_BM25_B, ranges)
  const fields = raw.fields
  if (fields === undefined) return undefined
  if (!isPlainObject(fields)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'bm25.fields must be an object that maps a field to its parameters',
    )
  }
  return fields
}

export function validateBM25Shape(raw: unknown, ranges: BM25ValueRanges): void {
  const fields = fieldsOfCheckedSetting(raw, ranges)
  if (fields === undefined) return
  for (const name of Object.keys(fields)) requireFieldPair(name, fields[name], ranges)
}

export function validateBM25Params(
  raw: unknown,
  schema: SchemaDefinition,
  unknownFieldCode: ErrorCode,
  ranges: BM25ValueRanges = 'settable',
): void {
  const fields = fieldsOfCheckedSetting(raw, ranges)
  if (fields === undefined) return
  const names = Object.keys(fields)
  if (names.length === 0) return
  const flatSchema = flattenSchema(schema)
  for (const name of names) {
    requireScoredField(name, flatSchema, unknownFieldCode)
    requireFieldPair(name, fields[name], ranges)
  }
}

function presentPair(pair: BM25FieldParams): BM25FieldParams {
  return {
    ...(pair.k1 !== undefined ? { k1: pair.k1 } : {}),
    ...(pair.b !== undefined ? { b: pair.b } : {}),
  }
}

export function storedBM25Params(params: BM25Params): BM25Params | undefined {
  const stored: BM25Params = presentPair(params)
  const fields = params.fields
  if (fields !== undefined) {
    const kept: Record<string, BM25FieldParams> = Object.create(null)
    let holdsField = false
    for (const name of Object.keys(fields)) {
      const pair = presentPair(fields[name])
      if (pair.k1 === undefined && pair.b === undefined) continue
      kept[name] = pair
      holdsField = true
    }
    if (holdsField) stored.fields = kept
  }
  return Object.keys(stored).length === 0 ? undefined : stored
}
