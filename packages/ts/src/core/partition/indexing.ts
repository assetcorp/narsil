import { createGeoIndex } from '../../geo/geo-index'
import type { BaseFieldType, SchemaField } from '../../schema/validator'
import type { LanguageModule } from '../../types/language'
import { MAX_TERM_FREQUENCY } from '../constants'
import type { ReadonlyStoredDocument } from '../document-store'
import {
  type BooleanFieldIndex,
  createBooleanIndex,
  createEnumIndex,
  createNumericIndex,
  type NumericFieldIndex,
} from '../field-index'
import { patternIndexOf } from '../pattern-index/host'
import { tokenize } from '../tokenizer'
import { visitTokens } from '../tokenizer/tokenize'
import { countPartialSpelling } from './partial-words/registry'
import type { SpellingCounts } from './partial-words/spellings'
import {
  getNestedValue,
  getOrCreateFieldNameIndex,
  type PartitionInsertOptions,
  type PartitionState,
  tokenizeOptions,
} from './utils'
import { forgetValueSize, recordValueSize } from './value-sizes'

export function ensureFieldIndex(state: PartitionState, fieldPath: string, base: BaseFieldType): void {
  if ((base === 'number' || base === 'number[]') && !state.numericIndexes.has(fieldPath)) {
    state.numericIndexes.set(fieldPath, createNumericIndex())
  } else if ((base === 'boolean' || base === 'boolean[]') && !state.booleanIndexes.has(fieldPath)) {
    state.booleanIndexes.set(fieldPath, createBooleanIndex())
  } else if ((base === 'enum' || base === 'enum[]') && !state.enumIndexes.has(fieldPath)) {
    state.enumIndexes.set(fieldPath, createEnumIndex())
  } else if (base === 'geopoint' && !state.geoIndexes.has(fieldPath)) {
    state.geoIndexes.set(fieldPath, createGeoIndex())
  }
}

function getOrCreateNumericIndex(state: PartitionState, fieldPath: string): NumericFieldIndex {
  let idx = state.numericIndexes.get(fieldPath)
  if (!idx) {
    idx = createNumericIndex()
    state.numericIndexes.set(fieldPath, idx)
  }
  return idx
}

function getOrCreateBooleanIndex(state: PartitionState, fieldPath: string): BooleanFieldIndex {
  let idx = state.booleanIndexes.get(fieldPath)
  if (!idx) {
    idx = createBooleanIndex()
    state.booleanIndexes.set(fieldPath, idx)
  }
  return idx
}

function resolveInternalId(state: PartitionState, docId: string): number {
  const internalId = state.docStore.getInternalId(docId)
  if (internalId === undefined) {
    throw new Error(`Internal ID not found for document "${docId}"`)
  }
  return internalId
}

type SurfaceCounts = Map<string, { token: string; count: number }>

export interface IndexedText {
  fieldLengths: Record<string, number>
  tokensByField: Record<string, string[]>
  partialSpellings: SpellingCounts | null
}

function emptyIndexedText(fields: readonly SchemaField[]): IndexedText {
  const holdsPartialField = fields.some(field => field.partial)
  return { fieldLengths: {}, tokensByField: {}, partialSpellings: holdsPartialField ? new Map() : null }
}

function partialSpellingsFor(field: SchemaField, indexed: IndexedText): SpellingCounts | null {
  return field.partial ? indexed.partialSpellings : null
}

function countSurface(counts: SurfaceCounts, surface: string | undefined, token: string): void {
  if (surface === undefined || surface.length === 0) return
  const existing = counts.get(surface)
  if (existing) {
    existing.count++
  } else {
    counts.set(surface, { token, count: 1 })
  }
}

function countOccurrence(
  counts: SurfaceCounts,
  spellings: SpellingCounts | null,
  surface: string | undefined,
  token: string,
): void {
  countSurface(counts, surface, token)
  if (spellings !== null) countPartialSpelling(spellings, token, surface ?? token, 1)
}

function addFieldOccurrences(occurrencesByToken: Map<string, number>, fieldTokens: readonly string[]): void {
  const fieldCounts = new Map<string, number>()
  for (const token of fieldTokens) fieldCounts.set(token, (fieldCounts.get(token) ?? 0) + 1)
  for (const [token, count] of fieldCounts) {
    const stored = count > MAX_TERM_FREQUENCY ? MAX_TERM_FREQUENCY : count
    occurrencesByToken.set(token, (occurrencesByToken.get(token) ?? 0) + stored)
  }
}

function applySurfaceCounts(state: PartitionState, counts: SurfaceCounts, direction: 1 | -1): void {
  for (const [surface, entry] of counts) {
    if (direction === 1) {
      state.surfaceRegistry.add(surface, entry.token, entry.count)
    } else {
      state.surfaceRegistry.subtract(surface, entry.count)
    }
  }
}

export function indexStringField(
  state: PartitionState,
  internalId: number,
  fieldPath: string,
  text: string,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  fieldLengths: Record<string, number>,
  tokensByField: Record<string, string[]>,
  spellings: SpellingCounts | null = null,
): void {
  const fieldTokenList: string[] = []
  const fieldNameIndex = getOrCreateFieldNameIndex(state.fieldNameTable, fieldPath)
  const opts = tokenizeOptions(options)
  const surfaceCounts: SurfaceCounts = new Map()

  if (state.trackPositions) {
    const tokenFreqs = new Map<string, { count: number; positions: number[] }>()
    visitTokens(text, language, opts, (token, position, surface) => {
      const existing = tokenFreqs.get(token)
      if (existing) {
        existing.count++
        existing.positions.push(position)
      } else {
        tokenFreqs.set(token, { count: 1, positions: [position] })
      }
      fieldTokenList.push(token)
      countOccurrence(surfaceCounts, spellings, surface, token)
    })

    for (const [token, freq] of tokenFreqs) {
      state.invertedIdx.insert(token, internalId, freq.count, fieldNameIndex, freq.positions)
    }
  } else {
    const tokenCounts = new Map<string, number>()
    visitTokens(text, language, opts, (token, _position, surface) => {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1)
      fieldTokenList.push(token)
      countOccurrence(surfaceCounts, spellings, surface, token)
    })

    for (const [token, count] of tokenCounts) {
      state.invertedIdx.insert(token, internalId, count, fieldNameIndex, null)
    }
  }

  applySurfaceCounts(state, surfaceCounts, 1)
  fieldLengths[fieldPath] = fieldTokenList.length
  tokensByField[fieldPath] = fieldTokenList
}

export function indexStringArrayField(
  state: PartitionState,
  internalId: number,
  fieldPath: string,
  arr: string[],
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  fieldLengths: Record<string, number>,
  tokensByField: Record<string, string[]>,
  spellings: SpellingCounts | null = null,
): void {
  const fieldTokenList: string[] = []
  const fieldNameIndex = getOrCreateFieldNameIndex(state.fieldNameTable, fieldPath)
  const opts = tokenizeOptions(options)
  const surfaceCounts: SurfaceCounts = new Map()

  if (state.trackPositions) {
    const tokenFreqs = new Map<string, { count: number; positions: number[] }>()
    let positionOffset = 0

    let itemTokenCount = 0
    const addToken = (token: string, position: number, surface: string | undefined): void => {
      const existing = tokenFreqs.get(token)
      if (existing) {
        existing.count++
        existing.positions.push(positionOffset + position)
      } else {
        tokenFreqs.set(token, { count: 1, positions: [positionOffset + position] })
      }
      fieldTokenList.push(token)
      countOccurrence(surfaceCounts, spellings, surface, token)
      itemTokenCount++
    }
    for (const item of arr) {
      itemTokenCount = 0
      visitTokens(item, language, opts, addToken)
      positionOffset += itemTokenCount
    }

    fieldLengths[fieldPath] = fieldTokenList.length

    for (const [token, freq] of tokenFreqs) {
      state.invertedIdx.insert(token, internalId, freq.count, fieldNameIndex, freq.positions)
    }
  } else {
    const tokenCounts = new Map<string, number>()

    const addToken = (token: string, _position: number, surface: string | undefined): void => {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1)
      fieldTokenList.push(token)
      countOccurrence(surfaceCounts, spellings, surface, token)
    }
    for (const item of arr) visitTokens(item, language, opts, addToken)

    fieldLengths[fieldPath] = fieldTokenList.length

    for (const [token, count] of tokenCounts) {
      state.invertedIdx.insert(token, internalId, count, fieldNameIndex, null)
    }
  }

  applySurfaceCounts(state, surfaceCounts, 1)
  tokensByField[fieldPath] = fieldTokenList
}

export function indexDocument(
  state: PartitionState,
  docId: string,
  document: Record<string, unknown>,
  fields: readonly SchemaField[],
  language: LanguageModule,
  options?: PartitionInsertOptions,
): IndexedText {
  const indexed = emptyIndexedText(fields)
  const { fieldLengths, tokensByField } = indexed
  const internalId = resolveInternalId(state, docId)

  for (const field of fields) {
    const { path: fieldPath, base, pattern } = field
    const value = getNestedValue(document, fieldPath)
    if (value === undefined || value === null) continue

    recordValueSize(state.sizeIndexes, internalId, fieldPath, base, value)
    ensureFieldIndex(state, fieldPath, base)
    if (pattern) patternIndexOf(state.patternIndexes, fieldPath).add(internalId, value)

    if (base === 'string') {
      indexStringField(
        state,
        internalId,
        fieldPath,
        value as string,
        language,
        options,
        fieldLengths,
        tokensByField,
        partialSpellingsFor(field, indexed),
      )
    } else if (base === 'number') {
      getOrCreateNumericIndex(state, fieldPath).insert(internalId, value as number)
    } else if (base === 'boolean') {
      getOrCreateBooleanIndex(state, fieldPath).insert(internalId, value as boolean)
    } else if (base === 'enum') {
      state.enumIndexes.get(fieldPath)?.insert(internalId, value as string)
    } else if (base === 'geopoint') {
      const geo = value as { lat: number; lon: number }
      state.geoIndexes.get(fieldPath)?.insert(internalId, geo.lat, geo.lon)
    } else if (base === 'string[]') {
      indexStringArrayField(
        state,
        internalId,
        fieldPath,
        value as string[],
        language,
        options,
        fieldLengths,
        tokensByField,
        partialSpellingsFor(field, indexed),
      )
    } else if (base === 'number[]') {
      const numIdx = getOrCreateNumericIndex(state, fieldPath)
      for (const num of value as number[]) numIdx.insert(internalId, num)
    } else if (base === 'boolean[]') {
      const boolIdx = getOrCreateBooleanIndex(state, fieldPath)
      for (const b of value as boolean[]) boolIdx.insert(internalId, b)
    } else if (base === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        for (const e of value as string[]) enumIdx.insert(internalId, e)
      }
    }
  }

  return indexed
}

export function removeFromIndexes(
  state: PartitionState,
  docId: string,
  storedDoc: ReadonlyStoredDocument,
  schemaFields: readonly SchemaField[],
  language: LanguageModule,
  options?: PartitionInsertOptions,
): IndexedText {
  const removed = emptyIndexedText(schemaFields)
  const { fieldLengths, tokensByField } = removed
  const fields = storedDoc.fields
  const internalId = resolveInternalId(state, docId)
  const opts = tokenizeOptions(options)
  const occurrencesByToken = new Map<string, number>()

  for (const field of schemaFields) {
    const { path: fieldPath, base, pattern } = field
    const value = getNestedValue(fields as Record<string, unknown>, fieldPath)
    if (value === undefined || value === null) continue
    forgetValueSize(state.sizeIndexes, internalId, fieldPath, base, value)
    if (pattern) state.patternIndexes.get(fieldPath)?.remove(internalId, value)

    if (base === 'string') {
      const result = tokenize(value as string, language, opts)
      fieldLengths[fieldPath] = result.tokens.length
      const fieldTokenList: string[] = []
      const surfaceCounts: SurfaceCounts = new Map()
      const spellings = partialSpellingsFor(field, removed)
      for (let i = 0; i < result.tokens.length; i++) {
        const t = result.tokens[i]
        fieldTokenList.push(t.token)
        countOccurrence(surfaceCounts, spellings, result.surfaces?.[i], t.token)
      }
      addFieldOccurrences(occurrencesByToken, fieldTokenList)
      applySurfaceCounts(state, surfaceCounts, -1)
      tokensByField[fieldPath] = fieldTokenList
    } else if (base === 'number') {
      state.numericIndexes.get(fieldPath)?.remove(internalId, value as number)
    } else if (base === 'boolean') {
      state.booleanIndexes.get(fieldPath)?.remove(internalId, value as boolean)
    } else if (base === 'enum') {
      state.enumIndexes.get(fieldPath)?.remove(internalId, value as string)
    } else if (base === 'geopoint') {
      state.geoIndexes.get(fieldPath)?.remove(internalId)
    } else if (base === 'string[]') {
      const arr = value as string[]
      const fieldTokenList: string[] = []
      const surfaceCounts: SurfaceCounts = new Map()
      const spellings = partialSpellingsFor(field, removed)
      for (const item of arr) {
        const result = tokenize(item, language, opts)
        for (let i = 0; i < result.tokens.length; i++) {
          const t = result.tokens[i]
          fieldTokenList.push(t.token)
          countOccurrence(surfaceCounts, spellings, result.surfaces?.[i], t.token)
        }
      }
      fieldLengths[fieldPath] = fieldTokenList.length
      addFieldOccurrences(occurrencesByToken, fieldTokenList)
      applySurfaceCounts(state, surfaceCounts, -1)
      tokensByField[fieldPath] = fieldTokenList
    } else if (base === 'number[]') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        for (const num of value as number[]) numIdx.remove(internalId, num)
      }
    } else if (base === 'boolean[]') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        for (const b of value as boolean[]) boolIdx.remove(internalId, b)
      }
    } else if (base === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        for (const e of value as string[]) enumIdx.remove(internalId, e)
      }
    }
  }

  for (const [token, occurrences] of occurrencesByToken) state.invertedIdx.remove(token, internalId, occurrences)

  return removed
}
