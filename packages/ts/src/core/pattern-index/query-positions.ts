import { schemaFieldsOf } from '../../schema/validator/schema'
import type { FilterExpression } from '../../types/filters'
import type { SchemaDefinition } from '../../types/schema'
import { codePointCount } from '../ordering/code-points'
import { foldedCodePointCount } from '../ordering/fold-compare'
import { PATTERN_TEST_OPERATORS } from './constants'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textPositions(text: unknown, caseFold: boolean): number {
  if (typeof text !== 'string') return 0
  return caseFold ? foldedCodePointCount(text) : codePointCount(text)
}

function largestTestOf(filter: Record<string, unknown>): number {
  const caseFold = filter.caseFold === true
  let largest = 0
  for (const operator of PATTERN_TEST_OPERATORS) {
    const operand = filter[operator]
    const texts = Array.isArray(operand) ? operand : [operand]
    for (const text of texts) largest = Math.max(largest, textPositions(text, caseFold))
  }
  return largest
}

function largestIn(expression: FilterExpression, patternFields: ReadonlySet<string>): number {
  let largest = 0
  if (isRecord(expression.fields)) {
    for (const [fieldPath, filter] of Object.entries(expression.fields)) {
      if (patternFields.has(fieldPath) && isRecord(filter)) largest = Math.max(largest, largestTestOf(filter))
    }
  }
  const nested = [...(expression.and ?? []), ...(expression.or ?? [])]
  if (expression.not !== undefined) nested.push(expression.not)
  for (const child of nested) largest = Math.max(largest, largestIn(child, patternFields))
  return largest
}

export function largestPatternTest(expression: FilterExpression | undefined, schema: SchemaDefinition): number {
  if (expression === undefined) return 0
  const patternFields = new Set<string>()
  for (const { path, pattern } of schemaFieldsOf(schema)) if (pattern) patternFields.add(path)
  return patternFields.size === 0 ? 0 : largestIn(expression, patternFields)
}
