import { appendFoldedCodePoints } from '../../../core/ordering'
import type { Narsil } from '../../../narsil'
import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument, IndexConfig } from '../../../types/schema'

export const PATTERN_INDEX = 'records'

export const patternConfig: IndexConfig = {
  schema: {
    body: 'string',
    code: 'verbatim',
    title: 'string:pattern',
    tags: 'verbatim[]',
    plain: 'string',
  },
  partitions: { maxPartitions: 3 },
}

const CODES = [
  'INV-2024-001',
  'inv-2024-002',
  'Straße',
  'STRASSE',
  'ΣΊΣΥΦΟΣ',
  'σίσυφος',
  'İstanbul',
  'ﬃx',
  'café',
  'café',
  '😀 smile 😀',
  'ab',
  '',
  'a',
  'aaaaaa',
  'abcabc',
  'connection refused',
  'Connection Refused at 10.0.0.1',
]

const TITLES = ['Error: disk full', 'ERROR: connection refused', 'warning', 'Fuß ball', 'FUSS BALL', 'résumé']

const TAGS: Array<string[] | undefined> = [
  ['alpha', 'BETA'],
  ['beta'],
  [],
  ['Straße', 'gamma'],
  undefined,
  ['😀', 'ab'],
]

export function patternDocuments(): AnyDocument[] {
  return CODES.map((code, at) => {
    const document: AnyDocument = { id: `r${String(at).padStart(2, '0')}`, body: 'record', plain: 'plain text' }
    if (at % 7 !== 6) document.code = code
    if (at % 5 !== 4) document.title = TITLES[at % TITLES.length]
    const tags = TAGS[at % TAGS.length]
    if (tags !== undefined) document.tags = tags
    return document
  })
}

export const PROBE_TEXTS = [
  '',
  'a',
  'ab',
  'abc',
  'aaa',
  'abca',
  'INV',
  'inv',
  '2024',
  'ss',
  'ß',
  'strasse',
  'σ',
  'ς',
  'σισυφοσ',
  'i̇',
  'ffi',
  'ﬃ',
  'café',
  'café',
  '😀',
  'refused',
  'REFUSED',
  'connection refused',
  'error',
  'fuss',
  'beta',
  'zzz',
]

function codePointsOf(text: string, caseFold: boolean): number[] {
  if (caseFold) {
    const folded: number[] = []
    appendFoldedCodePoints(text, folded)
    return folded
  }
  return Array.from(text, character => character.codePointAt(0) ?? 0)
}

function indexOfRun(value: number[], text: number[], from: number): number {
  for (let start = from; start + text.length <= value.length; start++) {
    let matched = true
    for (let at = 0; at < text.length && matched; at++) matched = value[start + at] === text[at]
    if (matched) return start
  }
  return -1
}

export type LiteralOperator = 'eq' | 'startsWith' | 'endsWith' | 'contains'

export function literalPasses(value: string, operator: LiteralOperator, text: string, caseFold: boolean): boolean {
  const valuePoints = codePointsOf(value, caseFold)
  const textPoints = codePointsOf(text, caseFold)
  if (operator === 'eq') {
    return valuePoints.length === textPoints.length && indexOfRun(valuePoints, textPoints, 0) === 0
  }
  if (operator === 'startsWith') return indexOfRun(valuePoints.slice(0, textPoints.length), textPoints, 0) === 0
  if (operator === 'endsWith') {
    const start = valuePoints.length - textPoints.length
    return start >= 0 && indexOfRun(valuePoints, textPoints, start) === start
  }
  return indexOfRun(valuePoints, textPoints, 0) >= 0
}

function anyElement(value: unknown, test: (text: string) => boolean): boolean {
  if (typeof value === 'string') return test(value)
  return Array.isArray(value) && value.some(element => typeof element === 'string' && test(element))
}

function holdsValue(value: unknown): boolean {
  return typeof value === 'string' || Array.isArray(value)
}

export function referenceIds(documents: AnyDocument[], field: string, filter: FieldFilter): string[] {
  const probe = filter as Record<string, unknown>
  const caseFold = probe.caseFold === true
  const passes = (value: unknown): boolean => {
    const equals = (text: string) => (element: string) => literalPasses(element, 'eq', text, caseFold)
    if (typeof probe.eq === 'string' && !anyElement(value, equals(probe.eq))) return false
    if (typeof probe.ne === 'string' && (!holdsValue(value) || anyElement(value, equals(probe.ne)))) return false
    if (Array.isArray(probe.in) && !probe.in.some(text => anyElement(value, equals(text)))) return false
    if (Array.isArray(probe.nin) && (!holdsValue(value) || probe.nin.some(text => anyElement(value, equals(text))))) {
      return false
    }
    for (const operator of ['startsWith', 'endsWith', 'contains'] as const) {
      const text = probe[operator]
      if (typeof text !== 'string') continue
      if (!anyElement(value, element => literalPasses(element, operator, text, caseFold))) return false
    }
    return true
  }
  return documents
    .filter(document => passes(document[field]))
    .map(document => String(document.id))
    .sort()
}

export async function listedIds(narsil: Narsil, field: string, filter: FieldFilter): Promise<string[]> {
  const listed = await narsil.listDocuments(PATTERN_INDEX, { filters: { fields: { [field]: filter } }, limit: 500 })
  return listed.documents.map(document => document.id).sort()
}

export async function queriedIds(narsil: Narsil, field: string, filter: FieldFilter): Promise<string[]> {
  const result = await narsil.query(PATTERN_INDEX, {
    term: 'record',
    filters: { fields: { [field]: filter } },
    limit: 500,
  })
  return result.hits.map(hit => hit.id).sort()
}
