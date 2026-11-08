import type { SchemaField } from '../../schema/validator'
import type { LanguageModule } from '../../types/language'
import { ARRAY_POSITION_GAP } from '../constants'
import { PreparedTokens } from '../segment-writes/prepared-tokens'
import { visitTokens } from '../tokenizer/tokenize'
import { countPartialSpelling } from './partial-words/registry'
import type { ReadonlySpellingCounts, SpellingCounts } from './partial-words/spellings'
import { getNestedValue, type PartitionInsertOptions, tokenizeOptions } from './utils'

export interface PreparedTextField {
  readonly length: number
  readonly records: ReturnType<PreparedTokens['finish']>
  readonly surfaces: ReadonlyMap<string, { readonly token: string; readonly count: number }>
}

export interface PreparedText {
  readonly fieldLengths: Readonly<Record<string, number>>
  readonly tokens: ReadonlySet<string>
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

function prepareField(
  value: string | readonly string[],
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  tokens: Set<string>,
  spellings: SpellingCounts | null,
): PreparedTextField {
  const surfaces = new Map<string, { token: string; count: number }>()
  const records = new PreparedTokens()
  const tokenizing = tokenizeOptions(options)
  let offset = 0
  let lastPosition = -1
  let length = 0
  let packed = false
  const collect = (token: string, position: number, surface: string | undefined): void => {
    if (!packed) records.add(token, offset + position, surface)
    tokens.add(token)
    length++
    lastPosition = position
    if (surface !== undefined && surface.length > 0) {
      const shown = surfaces.get(surface)
      if (shown === undefined) surfaces.set(surface, { token, count: 1 })
      else shown.count++
    }
    if (spellings !== null) countPartialSpelling(spellings, token, surface ?? token, 1)
  }
  const append = (tokens: Uint32Array, units: Uint16Array): void => {
    records.append(tokens, units, offset)
    packed = true
  }
  if (typeof value === 'string') {
    visitTokens(value, language, tokenizing, collect, append)
  } else {
    for (const item of value) {
      lastPosition = -1
      packed = false
      visitTokens(item, language, tokenizing, collect, append)
      if (lastPosition >= 0) offset += lastPosition + 1 + ARRAY_POSITION_GAP
    }
  }
  return { length, records: records.finish(), surfaces }
}

export function prepareDocumentText(
  document: Readonly<Record<string, unknown>>,
  schemaFields: readonly SchemaField[],
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
): PreparedText {
  const fieldLengths: Record<string, number> = Object.create(null)
  const tokens = new Set<string>()
  const partialSpellings: SpellingCounts | null = schemaFields.some(field => field.partial) ? new Map() : null
  const fields = new Map<string, PreparedTextField>()
  for (const field of schemaFields) {
    if (field.base !== 'string' && field.base !== 'string[]') continue
    const value = getNestedValue(document, field.path)
    if (value === undefined || value === null) continue
    const prepared = prepareField(
      value as string | string[],
      language,
      options,
      tokens,
      field.partial ? partialSpellings : null,
    )
    fieldLengths[field.path] = prepared.length
    fields.set(field.path, prepared)
  }
  return { fieldLengths, tokens, partialSpellings, fields }
}
