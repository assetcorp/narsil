import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import { seededRandom } from '../../filters/pattern/random-corpus'
import { codePointsOf, textValuesOf } from './oracle'

export const INDEX = 'operations'
export const COMMON_TERM = 'entry'

export type PatternField = 'line' | 'sku' | 'emails'

export const SCHEMA: SchemaDefinition = {
  body: 'string',
  line: 'string:pattern',
  sku: 'verbatim',
  emails: 'verbatim[]',
}

const SERVICES = ['payment-service', 'Payment-Gateway', 'inventory', 'STRASSE-Router', 'Straße-router', 'auth']
const LEVELS = ['ERROR', 'error', 'Error', 'WARN', 'info']
const MESSAGES = [
  'Connection refused to 10.0.0.12:5432',
  'connection REFUSED to 10.0.0.7:6379',
  'Timeout after 3000 ms',
  'Größe überschritten für ΣΊΣΥΦΟΣ',
  'σίσυφοσ reached the oﬃce in İstanbul',
  'retrying 😀 later',
  'café au lait',
  'café au lait',
  '日本語のログ行',
  '',
]
const PEOPLE = ['Ama.Mensah', 'kofi.boateng', 'Efua.Owusu', 'YAW.ASANTE', 'Jürgen.Weiß', 'Σοφία']
const DOMAINS = ['example.com', 'Example.ORG', 'mail.example.com', 'straße.de']

export function operationsCorpus(count: number, seed: number): AnyDocument[] {
  const random = seededRandom(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  return Array.from({ length: count }, (_, at) => {
    const document: AnyDocument = { id: `op${String(at).padStart(5, '0')}`, body: COMMON_TERM }
    if (at % 13 !== 0) {
      const time = `2024-03-${String(1 + (at % 28)).padStart(2, '0')}T10:${String(at % 60).padStart(2, '0')}:00Z`
      document.line = `${time} ${pick(LEVELS)} [${pick(SERVICES)}] ${pick(MESSAGES)} (attempt ${1 + (at % 5)})`
    }
    if (at % 11 !== 0)
      document.sku = `${at % 2 === 0 ? 'SKU' : 'sku'}-${2020 + (at % 6)}-${String(at).padStart(5, '0')}`
    if (at % 7 !== 0) {
      document.emails = Array.from({ length: at % 4 }, () => `${pick(PEOPLE)}@${pick(DOMAINS)}`)
    }
    return document
  })
}

function sliceByCodePoints(value: string, start: number, length: number): string {
  return Array.from(value)
    .slice(start, start + length)
    .join('')
}

function variantOf(text: string, random: () => number): string {
  const choice = Math.floor(random() * 4)
  if (choice === 0) return text.toUpperCase()
  if (choice === 1) return text.toLowerCase()
  if (choice === 2) return String.fromCodePoint(...codePointsOf(text, true))
  return text
}

const SINGLE_TEXT_TESTS = ['eq', 'ne', 'startsWith', 'endsWith', 'contains'] as const

export function generatedProbes(
  documents: readonly AnyDocument[],
  count: number,
  seed: number,
): Array<[PatternField, FieldFilter]> {
  const random = seededRandom(seed)
  const fields: PatternField[] = ['line', 'sku', 'emails']
  const probes: Array<[PatternField, FieldFilter]> = []
  while (probes.length < count) {
    const field = fields[Math.floor(random() * fields.length)]
    const values = textValuesOf(documents[Math.floor(random() * documents.length)], field)
    if (values.length === 0) continue
    const value = values[Math.floor(random() * values.length)]
    const length = Array.from(value).length
    const start = Math.floor(random() * Math.max(1, length))
    const piece = sliceByCodePoints(value, start, 1 + Math.floor(random() * 8))
    const caseFold = random() < 0.5
    const test = SINGLE_TEXT_TESTS[Math.floor(random() * SINGLE_TEXT_TESTS.length)]
    const whole = test === 'eq' || test === 'ne'
    const text = variantOf(
      whole ? value : test === 'startsWith' ? sliceByCodePoints(value, 0, 1 + start) : piece,
      random,
    )
    if (random() < 0.2) {
      probes.push([
        field,
        { [random() < 0.5 ? 'in' : 'nin']: [text, variantOf(value, random), 'absent value'], caseFold },
      ])
    } else {
      probes.push([field, { [test]: text, caseFold }])
    }
  }
  return probes
}

export const EDGE_PROBES: Array<[PatternField, FieldFilter]> = [
  ['line', { contains: 'refused' }],
  ['line', { contains: 'REFUSED', caseFold: true }],
  ['line', { contains: 'strasse-router', caseFold: true }],
  ['line', { contains: 'STRASSE', caseFold: false }],
  ['line', { contains: 'GRÖSSE', caseFold: true }],
  ['line', { contains: 'σίσυφοσ', caseFold: true }],
  ['line', { contains: 'ΣΊΣΥΦΟΣ' }],
  ['line', { contains: 'office', caseFold: true }],
  ['line', { contains: 'OFFICE', caseFold: true }],
  ['line', { contains: 'i̇stanbul', caseFold: true }],
  ['line', { contains: 'istanbul', caseFold: true }],
  ['line', { contains: '😀' }],
  ['line', { contains: 'café' }],
  ['line', { contains: 'café' }],
  ['line', { contains: '日本' }],
  ['line', { contains: 'e' }],
  ['line', { contains: 'ß', caseFold: true }],
  ['line', { contains: 'ss', caseFold: true }],
  ['line', { contains: '' }],
  ['line', { contains: 'no such text anywhere' }],
  ['line', { endsWith: '(attempt 3)' }],
  ['line', { endsWith: 'LATER (ATTEMPT 2)', caseFold: true }],
  ['line', { startsWith: '2024-03-07' }],
  ['line', { startsWith: '' }],
  ['line', { ne: '' }],
  ['line', { startsWith: '2024', contains: 'error', endsWith: '1)', caseFold: true }],
  ['sku', { eq: 'SKU-2022-00002' }],
  ['sku', { eq: 'sku-2022-00002', caseFold: true }],
  ['sku', { ne: 'SKU-2022-00002' }],
  ['sku', { ne: 'sku-2022-00002', caseFold: true }],
  ['sku', { in: ['SKU-2020-00000', 'sku-2021-00001', 'SKU-1999-00000'] }],
  ['sku', { in: ['sku-2020-00000', 'SKU-2021-00001'], caseFold: true }],
  ['sku', { nin: ['SKU-2020-00000', 'sku-2021-00001'] }],
  ['sku', { nin: ['sku-2020-00000'], caseFold: true }],
  ['sku', { in: [] }],
  ['sku', { nin: [] }],
  ['sku', { contains: '-0001' }],
  ['emails', { contains: 'ama.mensah@', caseFold: true }],
  ['emails', { endsWith: '@example.org' }],
  ['emails', { endsWith: '@example.org', caseFold: true }],
  ['emails', { endsWith: '@strasse.de', caseFold: true }],
  ['emails', { eq: 'kofi.boateng@mail.example.com' }],
  ['emails', { ne: 'kofi.boateng@mail.example.com' }],
  ['emails', { nin: ['YAW.ASANTE@example.com'], caseFold: true }],
  ['emails', { contains: 'weiss', caseFold: true }],
]
