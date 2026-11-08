import type { FilterExpression } from '../types/filters'
import { MAX_FILTER_DEPTH } from './constants'

const TEXT_RANGE_OPERATORS = ['gt', 'gte', 'lt', 'lte'] as const
const NESTED_CLAUSES = ['and', 'or'] as const
const ACCESSOR = Symbol('accessor')

interface PendingExpression {
  expression: unknown
  depth: number
}

function peek(target: object, key: string | number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor !== undefined) return 'value' in descriptor ? descriptor.value : ACCESSOR
  return key in target ? ACCESSOR : undefined
}

function holdsTextBound(value: unknown): boolean {
  return value === ACCESSOR || typeof value === 'string'
}

function fieldTestHoldsTextRange(test: unknown): boolean {
  if (test === ACCESSOR) return true
  if (typeof test !== 'object' || test === null) return false
  for (const operator of TEXT_RANGE_OPERATORS) {
    if (holdsTextBound(peek(test, operator))) return true
  }
  const between = peek(test, 'between')
  if (between === ACCESSOR) return true
  return Array.isArray(between) && holdsTextBound(peek(between, 0))
}

function fieldsHoldTextRange(fields: unknown): boolean {
  if (fields === ACCESSOR) return true
  if (typeof fields !== 'object' || fields === null) return false
  for (const fieldPath of Object.keys(fields)) {
    if (fieldTestHoldsTextRange(peek(fields, fieldPath))) return true
  }
  return false
}

function queueClause(list: unknown, depth: number, pending: PendingExpression[]): boolean {
  if (list === ACCESSOR) return true
  if (!Array.isArray(list)) return false
  const length = peek(list, 'length')
  if (typeof length !== 'number') return true
  for (let at = 0; at < length; at++) {
    const expression = peek(list, at)
    if (expression === ACCESSOR) return true
    if (typeof expression !== 'object' || expression === null) return false
    pending.push({ expression, depth })
  }
  return false
}

function collectTextRangeFields(fields: unknown, found: string[]): boolean {
  if (fields === ACCESSOR) return false
  if (typeof fields !== 'object' || fields === null) return true
  for (const fieldPath of Object.keys(fields)) {
    if (fieldTestHoldsTextRange(peek(fields, fieldPath))) found.push(fieldPath)
  }
  return true
}

export function textRangeFieldsOf(filters: FilterExpression | null | undefined): string[] | null {
  const found: string[] = []
  if (filters === undefined || filters === null) return found
  const pending: PendingExpression[] = [{ expression: filters, depth: 0 }]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined) break
    const { expression, depth } = next
    if (expression === ACCESSOR) return null
    if (typeof expression !== 'object' || expression === null) continue
    if (depth > MAX_FILTER_DEPTH || seen.has(expression)) continue
    seen.add(expression)
    if (!collectTextRangeFields(peek(expression, 'fields'), found)) return null
    for (const clause of NESTED_CLAUSES) {
      if (queueClause(peek(expression, clause), depth + 1, pending)) return null
    }
    pending.push({ expression: peek(expression, 'not'), depth: depth + 1 })
  }
  return found
}

export function filtersHoldTextRange(filters: FilterExpression | null | undefined): boolean {
  if (filters === undefined || filters === null) return false
  const pending: PendingExpression[] = [{ expression: filters, depth: 0 }]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined) return false
    const { expression, depth } = next
    if (expression === ACCESSOR) return true
    if (typeof expression !== 'object' || expression === null) continue
    if (depth > MAX_FILTER_DEPTH || seen.has(expression)) continue
    seen.add(expression)
    if (fieldsHoldTextRange(peek(expression, 'fields'))) return true
    for (const clause of NESTED_CLAUSES) {
      if (queueClause(peek(expression, clause), depth + 1, pending)) return true
    }
    pending.push({ expression: peek(expression, 'not'), depth: depth + 1 })
  }
  return false
}
