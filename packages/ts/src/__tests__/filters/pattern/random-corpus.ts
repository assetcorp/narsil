import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'

export type Random = () => number

const PIECES = [
  'a',
  'b',
  'c',
  'A',
  'B',
  'ab',
  'AB',
  'abc',
  's',
  'S',
  'ss',
  'SS',
  'ß',
  'ẞ',
  'σ',
  'Σ',
  'ς',
  'İ',
  'i',
  'ﬃ',
  'ffi',
  'é',
  'é',
  '😀',
  '-',
  ' ',
  '0',
  '42',
]

const OPERATORS = ['contains', 'eq', 'ne', 'startsWith', 'endsWith', 'in', 'nin'] as const

export function seededRandom(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

function below(random: Random, limit: number): number {
  return Math.floor(random() * limit)
}

function pick<T>(random: Random, items: readonly T[]): T {
  return items[below(random, items.length)]
}

export function randomText(random: Random, maxPieces: number): string {
  let text = ''
  const pieces = below(random, maxPieces + 1)
  for (let piece = 0; piece < pieces; piece++) text += pick(random, PIECES)
  return text
}

function randomValue(random: Random): string {
  return random() < 0.1 ? randomText(random, 60) : randomText(random, 8)
}

function randomTags(random: Random): string[] {
  return Array.from({ length: below(random, 4) }, () => randomValue(random))
}

export function randomDocument(random: Random, id: string): AnyDocument {
  const document: AnyDocument = { id, body: 'record', rank: below(random, 100) }
  if (random() < 0.85) document.code = randomValue(random)
  if (random() < 0.8) document.tags = randomTags(random)
  if (random() < 0.8) document.title = randomValue(random)
  return document
}

export function changedPatternFields(random: Random, document: AnyDocument): AnyDocument {
  const changed: AnyDocument = { ...document, rank: below(random, 100) }
  const roll = random()
  if (roll < 0.3) changed.code = randomValue(random)
  else if (roll < 0.45) delete changed.code
  else if (roll < 0.7) changed.tags = randomTags(random)
  else if (roll < 0.85) changed.title = randomValue(random)
  return changed
}

function sliceOf(random: Random, value: string): string {
  const characters = Array.from(value)
  const start = below(random, characters.length + 1)
  const end = start + below(random, characters.length - start + 1)
  const slice = characters.slice(start, end).join('')
  const roll = random()
  if (roll < 0.2) return slice.toUpperCase()
  if (roll < 0.4) return slice.toLowerCase()
  return slice
}

function probeText(random: Random, values: readonly string[]): string {
  if (values.length === 0 || random() < 0.3) return randomText(random, 4)
  return sliceOf(random, pick(random, values))
}

export function valuesOf(documents: Iterable<AnyDocument>, field: string): string[] {
  const values: string[] = []
  for (const document of documents) {
    const value = document[field]
    if (typeof value === 'string') values.push(value)
    if (Array.isArray(value)) for (const element of value) if (typeof element === 'string') values.push(element)
  }
  return values
}

export function randomProbe(random: Random, values: readonly string[]): FieldFilter {
  const operator = pick(random, OPERATORS)
  const caseFold = random() < 0.5
  if (operator === 'in' || operator === 'nin') {
    const texts = Array.from({ length: 1 + below(random, 3) }, () => probeText(random, values))
    return { [operator]: texts, caseFold }
  }
  return { [operator]: probeText(random, values), caseFold }
}
