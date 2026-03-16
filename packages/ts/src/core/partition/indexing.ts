import { createGeoIndex } from '../../geo/geo-index'
import type { LanguageModule } from '../../types/language'
import type { FieldType } from '../../types/schema'
import { createBruteForceVectorStore } from '../../vector/brute-force'
import type { ReadonlyStoredDocument } from '../document-store'
import {
  type BooleanFieldIndex,
  createBooleanIndex,
  createEnumIndex,
  createNumericIndex,
  type NumericFieldIndex,
} from '../field-index'
import { tokenize } from '../tokenizer'
import {
  getNestedValue,
  type PartitionInsertOptions,
  type PartitionState,
  parseVectorDimension,
  tokenizeOptions,
} from './utils'

function ensureFieldIndex(state: PartitionState, fieldPath: string, fieldType: FieldType): void {
  if ((fieldType === 'number' || fieldType === 'number[]') && !state.numericIndexes.has(fieldPath)) {
    state.numericIndexes.set(fieldPath, createNumericIndex())
  } else if ((fieldType === 'boolean' || fieldType === 'boolean[]') && !state.booleanIndexes.has(fieldPath)) {
    state.booleanIndexes.set(fieldPath, createBooleanIndex())
  } else if ((fieldType === 'enum' || fieldType === 'enum[]') && !state.enumIndexes.has(fieldPath)) {
    state.enumIndexes.set(fieldPath, createEnumIndex())
  } else if (fieldType === 'geopoint' && !state.geoIndexes.has(fieldPath)) {
    state.geoIndexes.set(fieldPath, createGeoIndex())
  } else {
    const dim = parseVectorDimension(fieldType)
    if (dim !== null && !state.vectorStores.has(fieldPath)) {
      state.vectorStores.set(fieldPath, createBruteForceVectorStore(dim))
    }
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

const EMPTY_POSITIONS: readonly number[] = Object.freeze([] as number[])

function indexStringField(
  state: PartitionState,
  docId: string,
  fieldPath: string,
  text: string,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  fieldLengths: Record<string, number>,
  tokensByField: Record<string, string[]>,
): void {
  const result = tokenize(text, language, tokenizeOptions(options))
  fieldLengths[fieldPath] = result.tokens.length
  const fieldTokenList: string[] = []

  if (state.trackPositions) {
    const tokenFreqs = new Map<string, { count: number; positions: number[] }>()
    for (const t of result.tokens) {
      const existing = tokenFreqs.get(t.token)
      if (existing) {
        existing.count++
        existing.positions.push(t.position)
      } else {
        tokenFreqs.set(t.token, { count: 1, positions: [t.position] })
      }
      fieldTokenList.push(t.token)
    }

    for (const [token, freq] of tokenFreqs) {
      state.invertedIdx.insert(token, {
        docId,
        termFrequency: freq.count,
        fieldName: fieldPath,
        positions: freq.positions,
      })
    }
  } else {
    const tokenCounts = new Map<string, number>()
    for (const t of result.tokens) {
      tokenCounts.set(t.token, (tokenCounts.get(t.token) ?? 0) + 1)
      fieldTokenList.push(t.token)
    }

    for (const [token, count] of tokenCounts) {
      state.invertedIdx.insert(token, {
        docId,
        termFrequency: count,
        fieldName: fieldPath,
        positions: EMPTY_POSITIONS as number[],
      })
    }
  }

  tokensByField[fieldPath] = fieldTokenList
}

function indexStringArrayField(
  state: PartitionState,
  docId: string,
  fieldPath: string,
  arr: string[],
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  fieldLengths: Record<string, number>,
  tokensByField: Record<string, string[]>,
): void {
  const fieldTokenList: string[] = []

  if (state.trackPositions) {
    const tokenFreqs = new Map<string, { count: number; positions: number[] }>()
    let positionOffset = 0

    for (const item of arr) {
      const result = tokenize(item, language, tokenizeOptions(options))
      for (const t of result.tokens) {
        const existing = tokenFreqs.get(t.token)
        if (existing) {
          existing.count++
          existing.positions.push(positionOffset + t.position)
        } else {
          tokenFreqs.set(t.token, { count: 1, positions: [positionOffset + t.position] })
        }
        fieldTokenList.push(t.token)
      }
      positionOffset += result.tokens.length
    }

    fieldLengths[fieldPath] = fieldTokenList.length

    for (const [token, freq] of tokenFreqs) {
      state.invertedIdx.insert(token, {
        docId,
        termFrequency: freq.count,
        fieldName: fieldPath,
        positions: freq.positions,
      })
    }
  } else {
    const tokenCounts = new Map<string, number>()

    for (const item of arr) {
      const result = tokenize(item, language, tokenizeOptions(options))
      for (const t of result.tokens) {
        tokenCounts.set(t.token, (tokenCounts.get(t.token) ?? 0) + 1)
        fieldTokenList.push(t.token)
      }
    }

    fieldLengths[fieldPath] = fieldTokenList.length

    for (const [token, count] of tokenCounts) {
      state.invertedIdx.insert(token, {
        docId,
        termFrequency: count,
        fieldName: fieldPath,
        positions: EMPTY_POSITIONS as number[],
      })
    }
  }

  tokensByField[fieldPath] = fieldTokenList
}

export function indexDocument(
  state: PartitionState,
  docId: string,
  document: Record<string, unknown>,
  flatSchema: Record<string, FieldType>,
  language: LanguageModule,
  options?: PartitionInsertOptions,
): { fieldLengths: Record<string, number>; tokensByField: Record<string, string[]> } {
  const fieldLengths: Record<string, number> = {}
  const tokensByField: Record<string, string[]> = {}

  for (const [fieldPath, fieldType] of Object.entries(flatSchema)) {
    const value = getNestedValue(document, fieldPath)
    if (value === undefined || value === null) continue

    ensureFieldIndex(state, fieldPath, fieldType)

    if (fieldType === 'string') {
      indexStringField(state, docId, fieldPath, value as string, language, options, fieldLengths, tokensByField)
    } else if (fieldType === 'number') {
      getOrCreateNumericIndex(state, fieldPath).insert(docId, value as number)
    } else if (fieldType === 'boolean') {
      getOrCreateBooleanIndex(state, fieldPath).insert(docId, value as boolean)
    } else if (fieldType === 'enum') {
      state.enumIndexes.get(fieldPath)?.insert(docId, value as string)
    } else if (fieldType === 'geopoint') {
      const geo = value as { lat: number; lon: number }
      state.geoIndexes.get(fieldPath)?.insert(docId, geo.lat, geo.lon)
    } else if (fieldType === 'string[]') {
      indexStringArrayField(state, docId, fieldPath, value as string[], language, options, fieldLengths, tokensByField)
    } else if (fieldType === 'number[]') {
      const numIdx = getOrCreateNumericIndex(state, fieldPath)
      for (const num of value as number[]) numIdx.insert(docId, num)
    } else if (fieldType === 'boolean[]') {
      const boolIdx = getOrCreateBooleanIndex(state, fieldPath)
      for (const b of value as boolean[]) boolIdx.insert(docId, b)
    } else if (fieldType === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        for (const e of value as string[]) enumIdx.insert(docId, e)
      }
    } else {
      const dim = parseVectorDimension(fieldType)
      if (dim !== null) {
        const vec = value instanceof Float32Array ? value : new Float32Array(value as number[])
        state.vectorStores.get(fieldPath)?.insert(docId, vec)
      }
    }
  }

  return { fieldLengths, tokensByField }
}

export function removeFromIndexes(
  state: PartitionState,
  docId: string,
  storedDoc: ReadonlyStoredDocument,
  flatSchema: Record<string, FieldType>,
  language: LanguageModule,
  options?: PartitionInsertOptions,
): { fieldLengths: Record<string, number>; tokensByField: Record<string, string[]> } {
  const fieldLengths: Record<string, number> = {}
  const tokensByField: Record<string, string[]> = {}
  const fields = storedDoc.fields

  for (const [fieldPath, fieldType] of Object.entries(flatSchema)) {
    const value = getNestedValue(fields as Record<string, unknown>, fieldPath)
    if (value === undefined || value === null) continue

    if (fieldType === 'string') {
      const result = tokenize(value as string, language, tokenizeOptions(options))
      fieldLengths[fieldPath] = result.tokens.length
      const uniqueTokens = new Set<string>()
      const fieldTokenList: string[] = []
      for (const t of result.tokens) {
        uniqueTokens.add(t.token)
        fieldTokenList.push(t.token)
      }
      for (const token of uniqueTokens) state.invertedIdx.remove(token, docId)
      tokensByField[fieldPath] = fieldTokenList
    } else if (fieldType === 'number') {
      state.numericIndexes.get(fieldPath)?.remove(docId, value as number)
    } else if (fieldType === 'boolean') {
      state.booleanIndexes.get(fieldPath)?.remove(docId, value as boolean)
    } else if (fieldType === 'enum') {
      state.enumIndexes.get(fieldPath)?.remove(docId, value as string)
    } else if (fieldType === 'geopoint') {
      state.geoIndexes.get(fieldPath)?.remove(docId)
    } else if (fieldType === 'string[]') {
      const arr = value as string[]
      const uniqueTokens = new Set<string>()
      const fieldTokenList: string[] = []
      for (const item of arr) {
        const result = tokenize(item, language, tokenizeOptions(options))
        for (const t of result.tokens) {
          uniqueTokens.add(t.token)
          fieldTokenList.push(t.token)
        }
      }
      fieldLengths[fieldPath] = fieldTokenList.length
      for (const token of uniqueTokens) state.invertedIdx.remove(token, docId)
      tokensByField[fieldPath] = fieldTokenList
    } else if (fieldType === 'number[]') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        for (const num of value as number[]) numIdx.remove(docId, num)
      }
    } else if (fieldType === 'boolean[]') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        for (const b of value as boolean[]) boolIdx.remove(docId, b)
      }
    } else if (fieldType === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        for (const e of value as string[]) enumIdx.remove(docId, e)
      }
    } else {
      if (parseVectorDimension(fieldType) !== null) {
        state.vectorStores.get(fieldPath)?.remove(docId)
      }
    }
  }

  return { fieldLengths, tokensByField }
}

export function updateFieldIndexOnly(
  state: PartitionState,
  docId: string,
  oldFields: Readonly<Record<string, unknown>>,
  newDoc: Record<string, unknown>,
  flatSchema: Record<string, FieldType>,
): void {
  for (const [fieldPath, fieldType] of Object.entries(flatSchema)) {
    if (fieldType === 'string' || fieldType === 'string[]') continue

    const oldVal = getNestedValue(oldFields as Record<string, unknown>, fieldPath)
    const newVal = getNestedValue(newDoc, fieldPath)

    if (oldVal === newVal) continue
    if (
      oldVal !== undefined &&
      oldVal !== null &&
      newVal !== undefined &&
      newVal !== null &&
      typeof oldVal === typeof newVal &&
      JSON.stringify(oldVal) === JSON.stringify(newVal)
    )
      continue

    if (newVal !== undefined && newVal !== null) {
      ensureFieldIndex(state, fieldPath, fieldType)
    }

    if (fieldType === 'number') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        if (oldVal !== undefined && oldVal !== null) numIdx.remove(docId, oldVal as number)
        if (newVal !== undefined && newVal !== null) numIdx.insert(docId, newVal as number)
      }
    } else if (fieldType === 'boolean') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        if (oldVal !== undefined && oldVal !== null) boolIdx.remove(docId, oldVal as boolean)
        if (newVal !== undefined && newVal !== null) boolIdx.insert(docId, newVal as boolean)
      }
    } else if (fieldType === 'enum') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        if (oldVal !== undefined && oldVal !== null) enumIdx.remove(docId, oldVal as string)
        if (newVal !== undefined && newVal !== null) enumIdx.insert(docId, newVal as string)
      }
    } else if (fieldType === 'geopoint') {
      const geoIdx = state.geoIndexes.get(fieldPath)
      if (geoIdx) {
        if (oldVal !== undefined && oldVal !== null) geoIdx.remove(docId)
        if (newVal !== undefined && newVal !== null) {
          const geo = newVal as { lat: number; lon: number }
          geoIdx.insert(docId, geo.lat, geo.lon)
        }
      }
    } else if (fieldType === 'number[]') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        if (oldVal !== undefined && oldVal !== null) {
          for (const n of oldVal as number[]) numIdx.remove(docId, n)
        }
        if (newVal !== undefined && newVal !== null) {
          for (const n of newVal as number[]) numIdx.insert(docId, n)
        }
      }
    } else if (fieldType === 'boolean[]') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        if (oldVal !== undefined && oldVal !== null) {
          for (const b of oldVal as boolean[]) boolIdx.remove(docId, b)
        }
        if (newVal !== undefined && newVal !== null) {
          for (const b of newVal as boolean[]) boolIdx.insert(docId, b)
        }
      }
    } else if (fieldType === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        if (oldVal !== undefined && oldVal !== null) {
          for (const e of oldVal as string[]) enumIdx.remove(docId, e)
        }
        if (newVal !== undefined && newVal !== null) {
          for (const e of newVal as string[]) enumIdx.insert(docId, e)
        }
      }
    } else if (parseVectorDimension(fieldType) !== null) {
      const vecStore = state.vectorStores.get(fieldPath)
      if (vecStore) {
        vecStore.remove(docId)
        if (newVal !== undefined && newVal !== null) {
          const vec = newVal instanceof Float32Array ? newVal : new Float32Array(newVal as number[])
          vecStore.insert(docId, vec)
        }
      }
    }
  }
}
