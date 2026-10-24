import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'
import { codePointsOf } from '../../filters/pattern/case-folding'
import { expressionPasses } from '../../filters/pattern/expression-oracle'
import { acceptedTolerance, withinTolerance } from '../../filters/pattern/typo-oracle'

export { codePointsOf, UNICODE_FOLDS } from '../../filters/pattern/case-folding'

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

export function valuePasses(value: string, test: ValueTest, text: string, caseFold: boolean): boolean {
  const valuePoints = codePointsOf(value, caseFold)
  const textPoints = codePointsOf(text, caseFold)
  if (test === 'eq') return valuePoints.length === textPoints.length && sameAt(valuePoints, textPoints, 0)
  if (textPoints.length > valuePoints.length) return false
  if (test === 'startsWith') return sameAt(valuePoints, textPoints, 0)
  if (test === 'endsWith') return sameAt(valuePoints, textPoints, valuePoints.length - textPoints.length)
  return holds(valuePoints, textPoints)
}

export function textValuesOf(document: AnyDocument, field: string): string[] {
  const value = document[field]
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((element): element is string => typeof element === 'string')
}

function eqPasses(values: string[], text: string, tolerance: unknown, caseFold: boolean): boolean {
  if (tolerance === undefined) return values.some(value => valuePasses(value, 'eq', text, caseFold))
  const accepted = acceptedTolerance(text, tolerance)
  if (accepted === null) throw new Error(`The engine refuses a tolerance of ${String(tolerance)} on "${text}"`)
  return values.some(value => withinTolerance(value, text, accepted, caseFold))
}

function filterPasses(values: string[], filter: FieldFilter): boolean {
  const probe = filter as Record<string, unknown>
  const caseFold = probe.caseFold === true
  const any = (test: ValueTest, text: string) => values.some(value => valuePasses(value, test, text, caseFold))
  const texts = (operand: unknown): string[] => (Array.isArray(operand) ? operand : [])
  if (typeof probe.eq === 'string' && !eqPasses(values, probe.eq, probe.tolerance, caseFold)) return false
  if (typeof probe.ne === 'string' && any('eq', probe.ne)) return false
  if (probe.in !== undefined && !texts(probe.in).some(text => any('eq', text))) return false
  if (probe.nin !== undefined && texts(probe.nin).some(text => any('eq', text))) return false
  if (typeof probe.startsWith === 'string' && !any('startsWith', probe.startsWith)) return false
  if (typeof probe.endsWith === 'string' && !any('endsWith', probe.endsWith)) return false
  if (typeof probe.contains === 'string' && !any('contains', probe.contains)) return false
  for (const operator of ['wildcard', 'regex'] as const) {
    const pattern = probe[operator]
    if (typeof pattern !== 'string') continue
    if (!values.some(value => expressionPasses(value, operator, pattern, caseFold))) return false
  }
  return true
}

export function expectedIds(documents: readonly AnyDocument[], field: string, filter: FieldFilter): string[] {
  const ids: string[] = []
  for (const document of documents) {
    const stored = document[field]
    if (stored === undefined || stored === null) continue
    if (filterPasses(textValuesOf(document, field), filter)) ids.push(String(document.id))
  }
  return ids.sort()
}
