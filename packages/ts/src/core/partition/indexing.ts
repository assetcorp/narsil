import { createGeoIndex } from '../../geo/geo-index'
import type { LanguageModule } from '../../types/language'
import type { FieldType } from '../../types/schema'
import type { ReadonlyStoredDocument } from '../document-store'
import {
  type BooleanFieldIndex,
  createBooleanIndex,
  createEnumIndex,
  createNumericIndex,
  type NumericFieldIndex,
} from '../field-index'
import { tokenize, tokenizeIterator } from '../tokenizer'
import {
  getNestedValue,
  getOrCreateFieldNameIndex,
  type PartitionInsertOptions,
  type PartitionState,
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

function indexStringField(
  state: PartitionState,
  internalId: number,
  fieldPath: string,
  text: string,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  fieldLengths: Record<string, number>,
  tokensByField: Record<string, string[]>,
): void {
  const fieldTokenList: string[] = []
  const fieldNameIndex = getOrCreateFieldNameIndex(state.fieldNameTable, fieldPath)
  const opts = tokenizeOptions(options)

  if (state.trackPositions) {
    const tokenFreqs = new Map<string, { count: number; positions: number[] }>()
    for (const t of tokenizeIterator(text, language, opts)) {
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
      state.invertedIdx.insert(token, internalId, freq.count, fieldNameIndex, freq.positions)
    }
  } else {
    const tokenCounts = new Map<string, number>()
    for (const t of tokenizeIterator(text, language, opts)) {
      tokenCounts.set(t.token, (tokenCounts.get(t.token) ?? 0) + 1)
      fieldTokenList.push(t.token)
    }

    for (const [token, count] of tokenCounts) {
      state.invertedIdx.insert(token, internalId, count, fieldNameIndex, null)
    }
  }

  fieldLengths[fieldPath] = fieldTokenList.length
  tokensByField[fieldPath] = fieldTokenList
}

function indexStringArrayField(
  state: PartitionState,
  internalId: number,
  fieldPath: string,
  arr: string[],
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  fieldLengths: Record<string, number>,
  tokensByField: Record<string, string[]>,
): void {
  const fieldTokenList: string[] = []
  const fieldNameIndex = getOrCreateFieldNameIndex(state.fieldNameTable, fieldPath)
  const opts = tokenizeOptions(options)

  if (state.trackPositions) {
    const tokenFreqs = new Map<string, { count: number; positions: number[] }>()
    let positionOffset = 0

    for (const item of arr) {
      let itemTokenCount = 0
      for (const t of tokenizeIterator(item, language, opts)) {
        const existing = tokenFreqs.get(t.token)
        if (existing) {
          existing.count++
          existing.positions.push(positionOffset + t.position)
        } else {
          tokenFreqs.set(t.token, { count: 1, positions: [positionOffset + t.position] })
        }
        fieldTokenList.push(t.token)
        itemTokenCount++
      }
      positionOffset += itemTokenCount
    }

    fieldLengths[fieldPath] = fieldTokenList.length

    for (const [token, freq] of tokenFreqs) {
      state.invertedIdx.insert(token, internalId, freq.count, fieldNameIndex, freq.positions)
    }
  } else {
    const tokenCounts = new Map<string, number>()

    for (const item of arr) {
      for (const t of tokenizeIterator(item, language, opts)) {
        tokenCounts.set(t.token, (tokenCounts.get(t.token) ?? 0) + 1)
        fieldTokenList.push(t.token)
      }
    }

    fieldLengths[fieldPath] = fieldTokenList.length

    for (const [token, count] of tokenCounts) {
      state.invertedIdx.insert(token, internalId, count, fieldNameIndex, null)
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
  const internalId = resolveInternalId(state, docId)

  for (const [fieldPath, fieldType] of Object.entries(flatSchema)) {
    const value = getNestedValue(document, fieldPath)
    if (value === undefined || value === null) continue

    ensureFieldIndex(state, fieldPath, fieldType)

    if (fieldType === 'string') {
      indexStringField(state, internalId, fieldPath, value as string, language, options, fieldLengths, tokensByField)
    } else if (fieldType === 'number') {
      getOrCreateNumericIndex(state, fieldPath).insert(internalId, value as number)
    } else if (fieldType === 'boolean') {
      getOrCreateBooleanIndex(state, fieldPath).insert(internalId, value as boolean)
    } else if (fieldType === 'enum') {
      state.enumIndexes.get(fieldPath)?.insert(internalId, value as string)
    } else if (fieldType === 'geopoint') {
      const geo = value as { lat: number; lon: number }
      state.geoIndexes.get(fieldPath)?.insert(internalId, geo.lat, geo.lon)
    } else if (fieldType === 'string[]') {
      indexStringArrayField(
        state,
        internalId,
        fieldPath,
        value as string[],
        language,
        options,
        fieldLengths,
        tokensByField,
      )
    } else if (fieldType === 'number[]') {
      const numIdx = getOrCreateNumericIndex(state, fieldPath)
      for (const num of value as number[]) numIdx.insert(internalId, num)
    } else if (fieldType === 'boolean[]') {
      const boolIdx = getOrCreateBooleanIndex(state, fieldPath)
      for (const b of value as boolean[]) boolIdx.insert(internalId, b)
    } else if (fieldType === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        for (const e of value as string[]) enumIdx.insert(internalId, e)
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
  const internalId = resolveInternalId(state, docId)

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
      for (const token of uniqueTokens) state.invertedIdx.remove(token, internalId)
      tokensByField[fieldPath] = fieldTokenList
    } else if (fieldType === 'number') {
      state.numericIndexes.get(fieldPath)?.remove(internalId, value as number)
    } else if (fieldType === 'boolean') {
      state.booleanIndexes.get(fieldPath)?.remove(internalId, value as boolean)
    } else if (fieldType === 'enum') {
      state.enumIndexes.get(fieldPath)?.remove(internalId, value as string)
    } else if (fieldType === 'geopoint') {
      state.geoIndexes.get(fieldPath)?.remove(internalId)
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
      for (const token of uniqueTokens) state.invertedIdx.remove(token, internalId)
      tokensByField[fieldPath] = fieldTokenList
    } else if (fieldType === 'number[]') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        for (const num of value as number[]) numIdx.remove(internalId, num)
      }
    } else if (fieldType === 'boolean[]') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        for (const b of value as boolean[]) boolIdx.remove(internalId, b)
      }
    } else if (fieldType === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        for (const e of value as string[]) enumIdx.remove(internalId, e)
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
  const internalId = resolveInternalId(state, docId)

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
        if (oldVal !== undefined && oldVal !== null) numIdx.remove(internalId, oldVal as number)
        if (newVal !== undefined && newVal !== null) numIdx.insert(internalId, newVal as number)
      }
    } else if (fieldType === 'boolean') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        if (oldVal !== undefined && oldVal !== null) boolIdx.remove(internalId, oldVal as boolean)
        if (newVal !== undefined && newVal !== null) boolIdx.insert(internalId, newVal as boolean)
      }
    } else if (fieldType === 'enum') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        if (oldVal !== undefined && oldVal !== null) enumIdx.remove(internalId, oldVal as string)
        if (newVal !== undefined && newVal !== null) enumIdx.insert(internalId, newVal as string)
      }
    } else if (fieldType === 'geopoint') {
      const geoIdx = state.geoIndexes.get(fieldPath)
      if (geoIdx) {
        if (oldVal !== undefined && oldVal !== null) geoIdx.remove(internalId)
        if (newVal !== undefined && newVal !== null) {
          const geo = newVal as { lat: number; lon: number }
          geoIdx.insert(internalId, geo.lat, geo.lon)
        }
      }
    } else if (fieldType === 'number[]') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        if (oldVal !== undefined && oldVal !== null) {
          for (const n of oldVal as number[]) numIdx.remove(internalId, n)
        }
        if (newVal !== undefined && newVal !== null) {
          for (const n of newVal as number[]) numIdx.insert(internalId, n)
        }
      }
    } else if (fieldType === 'boolean[]') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        if (oldVal !== undefined && oldVal !== null) {
          for (const b of oldVal as boolean[]) boolIdx.remove(internalId, b)
        }
        if (newVal !== undefined && newVal !== null) {
          for (const b of newVal as boolean[]) boolIdx.insert(internalId, b)
        }
      }
    } else if (fieldType === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        if (oldVal !== undefined && oldVal !== null) {
          for (const e of oldVal as string[]) enumIdx.remove(internalId, e)
        }
        if (newVal !== undefined && newVal !== null) {
          for (const e of newVal as string[]) enumIdx.insert(internalId, e)
        }
      }
    }
  }
}
