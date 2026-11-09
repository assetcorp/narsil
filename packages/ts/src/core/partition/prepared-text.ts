import type { SchemaField } from '../../schema/validator'
import type { LanguageModule } from '../../types/language'
import { ARRAY_POSITION_GAP } from '../constants'
import { DocumentTexts, PREPARED_ROW_WORDS, PreparedTokens, packedTokens } from '../segment-writes/prepared-tokens'
import { storedText } from '../stored-values/text'
import { visitTokens } from '../tokenizer/tokenize'
import { countPartialSpelling } from './partial-words/registry'
import type { ReadonlySpellingCounts, SpellingCounts } from './partial-words/spellings'
import { getNestedValue, type PartitionInsertOptions, tokenizeOptions } from './utils'

const TOKEN_RECORD_WORDS = 8
const ABSENT_TEXT = 0xffffffff

export interface PreparedTextField {
  readonly length: number
  readonly records: ReturnType<PreparedTokens['finish']>
}

export interface PreparedSurface {
  readonly token: string
  readonly count: number
}

function countSurface(surfaces: Map<string, { token: string; count: number }>, surface: string, token: string): void {
  if (surface.length === 0) return
  const shown = surfaces.get(surface)
  if (shown === undefined) surfaces.set(surface, { token, count: 1 })
  else shown.count++
}

export function preparedSurfaces(field: PreparedTextField): ReadonlyMap<string, PreparedSurface> {
  const surfaces = new Map<string, { token: string; count: number }>()
  const records = field.records
  const texts = records.texts
  if (texts !== null) {
    const rows = records.rows
    for (let row = 0; row < records.count * PREPARED_ROW_WORDS; row += PREPARED_ROW_WORDS) {
      const surface = rows[row + 1]
      if (surface !== ABSENT_TEXT) countSurface(surfaces, texts[surface], texts[rows[row]])
    }
    return surfaces
  }
  const { tokens, units } = packedTokens(records)
  for (let at = 0; at < tokens.length; at += TOKEN_RECORD_WORDS) {
    if (tokens[at + 3] === ABSENT_TEXT || tokens[at + 4] === 0) continue
    countSurface(
      surfaces,
      storedText(units, tokens[at + 3], tokens[at + 4]),
      storedText(units, tokens[at + 1], tokens[at + 2]),
    )
  }
  return surfaces
}

export interface PreparedText {
  readonly fieldLengths: Readonly<Record<string, number>>
  readonly partialSpellings: ReadonlySpellingCounts | null
  readonly fields: ReadonlyMap<string, PreparedTextField>
  readonly removalSpellings?: ReadonlyMap<string, ReadonlyMap<string, PreparedRemovalSpelling>>
}

export interface PreparedRemovalSpelling {
  readonly count: number
  readonly normalized: string | null
}

export interface PreparedTextChange {
  readonly before?: PreparedText
  readonly after?: PreparedText
}

function countPackedSpellings(spellings: SpellingCounts, tokens: Uint32Array, count: number, units: Uint16Array): void {
  for (let at = 1; at < 1 + count * TOKEN_RECORD_WORDS; at += TOKEN_RECORD_WORDS) {
    const term = storedText(units, tokens[at + 1], tokens[at + 2])
    const surface = tokens[at + 3] === ABSENT_TEXT ? term : storedText(units, tokens[at + 3], tokens[at + 4])
    countPartialSpelling(spellings, term, surface, 1)
  }
}

function prepareField(
  value: string | readonly string[],
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  spellings: SpellingCounts | null,
  document: DocumentTexts,
): PreparedTextField {
  const records = new PreparedTokens(document)
  const tokenizing = tokenizeOptions(options)
  let offset = 0
  let lastPosition = -1
  let length = 0
  const collect = (token: string, position: number, surface: string | undefined): void => {
    records.add(token, offset + position, surface)
    length++
    lastPosition = position
    if (spellings !== null) countPartialSpelling(spellings, token, surface ?? token, 1)
  }
  const append = (tokens: Uint32Array, count: number, units: Uint16Array, unitCount: number): void => {
    if (count === 0) return
    records.append(tokens, count, units, unitCount, offset)
    length += count
    lastPosition = tokens[1 + (count - 1) * TOKEN_RECORD_WORDS]
    if (spellings !== null) countPackedSpellings(spellings, tokens, count, units)
  }
  if (typeof value === 'string') {
    visitTokens(value, language, tokenizing, collect, append)
  } else {
    for (const item of value) {
      lastPosition = -1
      visitTokens(item, language, tokenizing, collect, append)
      if (lastPosition >= 0) offset += lastPosition + 1 + ARRAY_POSITION_GAP
    }
  }
  return { length, records: records.finish() }
}

function holdsPartialField(schemaFields: readonly SchemaField[]): boolean {
  for (const field of schemaFields) if (field.partial === true) return true
  return false
}

export function prepareDocumentText(
  document: Readonly<Record<string, unknown>>,
  schemaFields: readonly SchemaField[],
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
): PreparedText {
  const fieldLengths: Record<string, number> = {}
  const partialSpellings: SpellingCounts | null = holdsPartialField(schemaFields) ? new Map() : null
  const fields = new Map<string, PreparedTextField>()
  const texts = new DocumentTexts()
  try {
    for (const field of schemaFields) {
      if (field.base !== 'string' && field.base !== 'string[]') continue
      const value = getNestedValue(document, field.path)
      if (value === undefined || value === null) continue
      const prepared = prepareField(
        value as string | string[],
        language,
        options,
        field.partial ? partialSpellings : null,
        texts,
      )
      fieldLengths[field.path] = prepared.length
      fields.set(field.path, prepared)
    }
  } finally {
    texts.release()
  }
  return { fieldLengths, partialSpellings, fields }
}
