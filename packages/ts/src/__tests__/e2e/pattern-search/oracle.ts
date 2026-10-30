import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'
import { codePointsOf } from '../../filters/pattern/case-folding'
import { expressionPasses } from '../../filters/pattern/expression-oracle'
import { acceptedTolerance, withinTolerance } from '../../filters/pattern/typo-oracle'

export { codePointsOf, UNICODE_FOLDS } from '../../filters/pattern/case-folding'

const SURROGATE = /[\uD800-\uDFFF]/

function sameAt(value: number[], text: number[], at: number): boolean {
  for (let offset = 0; offset < text.length; offset++) {
    if (value[at + offset] !== text[offset]) return false
  }
  return true
}

function holds(value: number[], text: number[]): boolean {
  for (let at = 0; at + text.length <= value.length; at++) {
    if (sameAt(value, text, at)) return true
  }
  return false
}

export type ValueTest = 'eq' | 'startsWith' | 'endsWith' | 'contains'

type ValueCheck = (value: string) => boolean

function literalCheck(test: ValueTest, text: string): ValueCheck {
  if (test === 'eq') return value => value === text
  if (test === 'startsWith') return value => value.startsWith(text)
  if (test === 'endsWith') return value => value.endsWith(text)
  return value => value.includes(text)
}

function valueCheck(test: ValueTest, text: string, caseFold: boolean): ValueCheck {
  if (!caseFold && !SURROGATE.test(text)) return literalCheck(test, text)
  const textPoints = codePointsOf(text, caseFold)
  return value => {
    const valuePoints = codePointsOf(value, caseFold)
    if (test === 'eq') return valuePoints.length === textPoints.length && sameAt(valuePoints, textPoints, 0)
    if (textPoints.length > valuePoints.length) return false
    if (test === 'startsWith') return sameAt(valuePoints, textPoints, 0)
    if (test === 'endsWith') return sameAt(valuePoints, textPoints, valuePoints.length - textPoints.length)
    return holds(valuePoints, textPoints)
  }
}

export function valuePasses(value: string, test: ValueTest, text: string, caseFold: boolean): boolean {
  return valueCheck(test, text, caseFold)(value)
}

export function textValuesOf(document: AnyDocument, field: string): string[] {
  const value = document[field]
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((element): element is string => typeof element === 'string')
}

function eqCheck(text: string, tolerance: unknown, caseFold: boolean): ValueCheck {
  if (tolerance === undefined) return valueCheck('eq', text, caseFold)
  const accepted = acceptedTolerance(text, tolerance)
  if (accepted === null) throw new Error(`The engine refuses a tolerance of ${String(tolerance)} on "${text}"`)
  return value => withinTolerance(value, text, accepted, caseFold)
}

function anyEqualCheck(operand: unknown, caseFold: boolean): ValueCheck {
  const texts = Array.isArray(operand) ? operand.filter((text): text is string => typeof text === 'string') : []
  if (!caseFold && !texts.some(text => SURROGATE.test(text))) {
    const members = new Set(texts)
    return value => members.has(value)
  }
  const checks = texts.map(text => valueCheck('eq', text, caseFold))
  return value => checks.some(check => check(value))
}

function filterCheck(filter: FieldFilter): (values: string[]) => boolean {
  const probe = filter as Record<string, unknown>
  const caseFold = probe.caseFold === true
  const required: ValueCheck[] = []
  const refused: ValueCheck[] = []
  if (typeof probe.eq === 'string') required.push(eqCheck(probe.eq, probe.tolerance, caseFold))
  if (typeof probe.ne === 'string') refused.push(valueCheck('eq', probe.ne, caseFold))
  if (probe.in !== undefined) required.push(anyEqualCheck(probe.in, caseFold))
  if (probe.nin !== undefined) refused.push(anyEqualCheck(probe.nin, caseFold))
  for (const test of ['startsWith', 'endsWith', 'contains'] as const) {
    const text = probe[test]
    if (typeof text === 'string') required.push(valueCheck(test, text, caseFold))
  }
  for (const operator of ['wildcard', 'regex'] as const) {
    const pattern = probe[operator]
    if (typeof pattern === 'string') required.push(value => expressionPasses(value, operator, pattern, caseFold))
  }
  return values => required.every(check => values.some(check)) && !refused.some(check => values.some(check))
}

export function expectedIds(documents: readonly AnyDocument[], field: string, filter: FieldFilter): string[] {
  const passes = filterCheck(filter)
  const ids: string[] = []
  for (const document of documents) {
    const stored = document[field]
    if (stored === undefined || stored === null) continue
    if (passes(textValuesOf(document, field))) ids.push(String(document.id))
  }
  return ids.sort()
}
