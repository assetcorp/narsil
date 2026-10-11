import { readFileSync } from 'node:fs'
import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'

const CASE_FOLDING_FILE = new URL('../../../../scripts/data/CaseFolding.txt', import.meta.url)
const FULL_FOLD_STATUSES = new Set(['C', 'F'])

function readFoldTable(): Map<number, number[]> {
  const table = new Map<number, number[]>()
  for (const line of readFileSync(CASE_FOLDING_FILE, 'utf8').split('\n')) {
    const [code, status, mapping] = line.split(';').map(part => part.trim())
    if (!FULL_FOLD_STATUSES.has(status)) continue
    table.set(
      Number.parseInt(code, 16),
      mapping.split(' ').map(hex => Number.parseInt(hex, 16)),
    )
  }
  return table
}

export const UNICODE_FOLDS = readFoldTable()

export function codePointsOf(text: string, caseFold: boolean): number[] {
  const codePoints: number[] = []
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (caseFold) codePoints.push(...(UNICODE_FOLDS.get(codePoint) ?? [codePoint]))
    else codePoints.push(codePoint)
  }
  return codePoints
}

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

function filterPasses(values: string[], filter: FieldFilter): boolean {
  const probe = filter as Record<string, unknown>
  const caseFold = probe.caseFold === true
  const any = (test: ValueTest, text: string) => values.some(value => valuePasses(value, test, text, caseFold))
  const texts = (operand: unknown): string[] => (Array.isArray(operand) ? operand : [])
  if (typeof probe.eq === 'string' && !any('eq', probe.eq)) return false
  if (typeof probe.ne === 'string' && any('eq', probe.ne)) return false
  if (probe.in !== undefined && !texts(probe.in).some(text => any('eq', text))) return false
  if (probe.nin !== undefined && texts(probe.nin).some(text => any('eq', text))) return false
  if (typeof probe.startsWith === 'string' && !any('startsWith', probe.startsWith)) return false
  if (typeof probe.endsWith === 'string' && !any('endsWith', probe.endsWith)) return false
  if (typeof probe.contains === 'string' && !any('contains', probe.contains)) return false
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
