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

type PointsOf = (value: string) => number[]

const pointsByCorpus = new WeakMap<readonly AnyDocument[], [Map<string, number[]>, Map<string, number[]>]>()

function pointsOverCorpus(documents: readonly AnyDocument[], caseFold: boolean): PointsOf {
  let caches = pointsByCorpus.get(documents)
  if (caches === undefined) {
    caches = [new Map(), new Map()]
    pointsByCorpus.set(documents, caches)
  }
  const cache = caches[caseFold ? 1 : 0]
  return value => {
    const known = cache.get(value)
    if (known !== undefined) return known
    const points = codePointsOf(value, caseFold)
    cache.set(value, points)
    return points
  }
}

function valueCheck(test: ValueTest, text: string, caseFold: boolean, pointsOf: PointsOf): ValueCheck {
  if (!caseFold && !SURROGATE.test(text)) return literalCheck(test, text)
  const textPoints = codePointsOf(text, caseFold)
  return value => {
    const valuePoints = pointsOf(value)
    if (test === 'eq') return valuePoints.length === textPoints.length && sameAt(valuePoints, textPoints, 0)
    if (textPoints.length > valuePoints.length) return false
    if (test === 'startsWith') return sameAt(valuePoints, textPoints, 0)
    if (test === 'endsWith') return sameAt(valuePoints, textPoints, valuePoints.length - textPoints.length)
    return holds(valuePoints, textPoints)
  }
}

export function valuePasses(value: string, test: ValueTest, text: string, caseFold: boolean): boolean {
  return valueCheck(test, text, caseFold, candidate => codePointsOf(candidate, caseFold))(value)
}

export function textValuesOf(document: AnyDocument, field: string): string[] {
  const value = document[field]
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((element): element is string => typeof element === 'string')
}

function eqCheck(text: string, tolerance: unknown, caseFold: boolean, pointsOf: PointsOf): ValueCheck {
  if (tolerance === undefined) return valueCheck('eq', text, caseFold, pointsOf)
  const accepted = acceptedTolerance(text, tolerance)
  if (accepted === null) throw new Error(`The engine refuses a tolerance of ${String(tolerance)} on "${text}"`)
  return value => withinTolerance(value, text, accepted, caseFold)
}

function anyEqualCheck(operand: unknown, caseFold: boolean, pointsOf: PointsOf): ValueCheck {
  const texts = Array.isArray(operand) ? operand.filter((text): text is string => typeof text === 'string') : []
  if (!caseFold && !texts.some(text => SURROGATE.test(text))) {
    const members = new Set(texts)
    return value => members.has(value)
  }
  const checks = texts.map(text => valueCheck('eq', text, caseFold, pointsOf))
  return value => checks.some(check => check(value))
}

function filterCheck(filter: FieldFilter, documents: readonly AnyDocument[]): (values: string[]) => boolean {
  const probe = filter as Record<string, unknown>
  const caseFold = probe.caseFold === true
  const pointsOf = pointsOverCorpus(documents, caseFold)
  const required: ValueCheck[] = []
  const refused: ValueCheck[] = []
  if (typeof probe.eq === 'string') required.push(eqCheck(probe.eq, probe.tolerance, caseFold, pointsOf))
  if (typeof probe.ne === 'string') refused.push(valueCheck('eq', probe.ne, caseFold, pointsOf))
  if (probe.in !== undefined) required.push(anyEqualCheck(probe.in, caseFold, pointsOf))
  if (probe.nin !== undefined) refused.push(anyEqualCheck(probe.nin, caseFold, pointsOf))
  for (const test of ['startsWith', 'endsWith', 'contains'] as const) {
    const text = probe[test]
    if (typeof text === 'string') required.push(valueCheck(test, text, caseFold, pointsOf))
  }
  for (const operator of ['wildcard', 'regex'] as const) {
    const pattern = probe[operator]
    if (typeof pattern === 'string') required.push(value => expressionPasses(value, operator, pattern, caseFold))
  }
  return values => required.every(check => values.some(check)) && !refused.some(check => values.some(check))
}

export function expectedIds(documents: readonly AnyDocument[], field: string, filter: FieldFilter): string[] {
  const passes = filterCheck(filter, documents)
  const ids: string[] = []
  for (const document of documents) {
    const stored = document[field]
    if (stored === undefined || stored === null) continue
    if (passes(textValuesOf(document, field))) ids.push(String(document.id))
  }
  return ids.sort()
}
