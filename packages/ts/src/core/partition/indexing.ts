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

export function ensureFieldIndex(state: PartitionState, fieldPath: string, fieldType: FieldType): void {
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

type SurfaceCounts = Map<string, { token: string; count: number }>

function countSurface(counts: SurfaceCounts, surface: string | undefined, token: string): void {
  if (surface === undefined || surface.length === 0) return
  const existing = counts.get(surface)
  if (existing) {
    existing.count++
  } else {
    counts.set(surface, { token, count: 1 })
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
  const surfaceCounts: SurfaceCounts = new Map()

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
      countSurface(surfaceCounts, t.surface, t.token)
    }

    for (const [token, freq] of tokenFreqs) {
      state.invertedIdx.insert(token, internalId, freq.count, fieldNameIndex, freq.positions)
    }
  } else {
    const tokenCounts = new Map<string, number>()
    for (const t of tokenizeIterator(text, language, opts)) {
      tokenCounts.set(t.token, (tokenCounts.get(t.token) ?? 0) + 1)
      fieldTokenList.push(t.token)
      countSurface(surfaceCounts, t.surface, t.token)
    }

    for (const [token, count] of tokenCounts) {
      state.invertedIdx.insert(token, internalId, count, fieldNameIndex, null)
    }
  }

  applySurfaceCounts(state, surfaceCounts, 1)
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
  const surfaceCounts: SurfaceCounts = new Map()

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
        countSurface(surfaceCounts, t.surface, t.token)
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
        countSurface(surfaceCounts, t.surface, t.token)
      }
    }

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
  const opts = tokenizeOptions(options)

  for (const [fieldPath, fieldType] of Object.entries(flatSchema)) {
    const value = getNestedValue(fields as Record<string, unknown>, fieldPath)
    if (value === undefined || value === null) continue

    if (fieldType === 'string') {
      const result = tokenize(value as string, language, opts)
      fieldLengths[fieldPath] = result.tokens.length
      const uniqueTokens = new Set<string>()
      const fieldTokenList: string[] = []
      const surfaceCounts: SurfaceCounts = new Map()
      for (let i = 0; i < result.tokens.length; i++) {
        const t = result.tokens[i]
        uniqueTokens.add(t.token)
        fieldTokenList.push(t.token)
        countSurface(surfaceCounts, result.surfaces?.[i], t.token)
      }
      for (const token of uniqueTokens) state.invertedIdx.remove(token, internalId)
      applySurfaceCounts(state, surfaceCounts, -1)
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
      const surfaceCounts: SurfaceCounts = new Map()
      for (const item of arr) {
        const result = tokenize(item, language, opts)
        for (let i = 0; i < result.tokens.length; i++) {
          const t = result.tokens[i]
          uniqueTokens.add(t.token)
          fieldTokenList.push(t.token)
          countSurface(surfaceCounts, result.surfaces?.[i], t.token)
        }
      }
      fieldLengths[fieldPath] = fieldTokenList.length
      for (const token of uniqueTokens) state.invertedIdx.remove(token, internalId)
      applySurfaceCounts(state, surfaceCounts, -1)
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
