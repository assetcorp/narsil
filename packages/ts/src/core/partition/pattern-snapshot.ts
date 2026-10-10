import { ErrorCodes, NarsilError } from '../../errors'
import { schemaFieldsOf } from '../../schema/validator'
import type { SerializedPatternIndex } from '../../types/internal'
import type { SchemaDefinition } from '../../types/schema'
import { PATTERN_RUN_CODE_POINTS } from '../pattern-index/constants'
import { patternIndexOf } from '../pattern-index/host'
import type { PatternIndexArrays, PatternIndexReader } from '../pattern-index/types'
import { getNestedValue, type PartitionState } from './utils'

function loadFailed(fieldPath: string, problem: string): NarsilError {
  return new NarsilError(
    ErrorCodes.PERSISTENCE_LOAD_FAILED,
    `The pattern index of field "${fieldPath}" in this partition is corrupt: ${problem}`,
    { field: fieldPath },
  )
}

function serializePatternIndex(state: PartitionState, fieldPath: string, index: PatternIndexReader) {
  const resolver = state.docStore.resolver()
  const arrays = index.toArrays(fieldPath, null)
  const positionOf = new Map<number, number>()
  const docIds: string[] = []
  for (const ordinal of arrays.docIds) {
    const externalId = resolver.toExternal(ordinal)
    if (externalId === undefined) continue
    positionOf.set(ordinal, docIds.length)
    docIds.push(externalId)
  }
  const runs: Record<string, number[]> = Object.create(null)
  for (let run = 0; run + 1 < arrays.offsets.length; run++) {
    const positions: number[] = []
    for (let at = arrays.offsets[run]; at < arrays.offsets[run + 1]; at++) {
      const position = positionOf.get(arrays.postings[at])
      if (position !== undefined) positions.push(position)
    }
    if (positions.length === 0) continue
    const base = run * PATTERN_RUN_CODE_POINTS
    runs[String.fromCodePoint(arrays.runs[base], arrays.runs[base + 1], arrays.runs[base + 2])] = positions
  }
  return { docIds, runs }
}

export function serializePatternIndexes(
  state: PartitionState,
  schema: SchemaDefinition,
): Record<string, SerializedPatternIndex> | undefined {
  const patternFields = schemaFieldsOf(schema).filter(field => field.pattern)
  if (patternFields.length === 0) return undefined
  const serialized: Record<string, SerializedPatternIndex> = Object.create(null)
  for (const { path: fieldPath } of patternFields) {
    const index = state.patternIndexes.get(fieldPath)
    serialized[fieldPath] =
      index === undefined ? { docIds: [], runs: {} } : serializePatternIndex(state, fieldPath, index)
  }
  return serialized
}

function appendRunCodePoints(fieldPath: string, key: string, out: number[]): void {
  const start = out.length
  for (const character of key) out.push(character.codePointAt(0) ?? 0)
  if (out.length - start !== PATTERN_RUN_CODE_POINTS) {
    throw loadFailed(fieldPath, `the key "${key}" holds no run of three code points`)
  }
}

function requirePositions(fieldPath: string, key: string, list: unknown, documentCount: number): number[] {
  if (!Array.isArray(list)) throw loadFailed(fieldPath, `the run "${key}" holds no list of positions`)
  let previous = -1
  for (const position of list) {
    if (!Number.isInteger(position) || position < 0 || position >= documentCount) {
      throw loadFailed(fieldPath, `the run "${key}" names position ${String(position)} outside its document list`)
    }
    if (position <= previous) {
      throw loadFailed(fieldPath, `the positions of the run "${key}" are out of ascending order`)
    }
    previous = position
  }
  return list
}

function decodePatternEntry(fieldPath: string, entry: SerializedPatternIndex): PatternIndexArrays {
  const runs: number[] = []
  const offsets: number[] = [0]
  const postings: number[] = []
  for (const [key, list] of Object.entries(entry.runs)) {
    appendRunCodePoints(fieldPath, key, runs)
    for (const position of requirePositions(fieldPath, key, list, entry.docIds.length)) postings.push(position)
    offsets.push(postings.length)
  }
  const positions = new Uint32Array(entry.docIds.length)
  for (let position = 0; position < positions.length; position++) positions[position] = position
  return {
    fieldPath,
    docIds: positions,
    runs: Uint32Array.from(runs),
    offsets: Uint32Array.from(offsets),
    postings: Uint32Array.from(postings),
  }
}

function rebuildPatternIndex(state: PartitionState, fieldPath: string): void {
  for (const [docId, stored] of state.docStore.all()) {
    const value = getNestedValue(stored.fields as Record<string, unknown>, fieldPath)
    if (value === undefined || value === null) continue
    const internalId = state.docStore.getInternalId(docId)
    if (internalId !== undefined) patternIndexOf(state.patternIndexes, fieldPath).add(internalId, value)
  }
}

export function loadPatternIndexes(
  state: PartitionState,
  serialized: Record<string, SerializedPatternIndex> | undefined,
  schema: SchemaDefinition,
): void {
  const resolver = state.docStore.resolver()
  for (const { path: fieldPath, pattern } of schemaFieldsOf(schema)) {
    if (!pattern) continue
    const entry = serialized !== undefined && Object.hasOwn(serialized, fieldPath) ? serialized[fieldPath] : undefined
    if (entry === undefined) {
      rebuildPatternIndex(state, fieldPath)
      continue
    }
    const decoded = decodePatternEntry(fieldPath, entry)
    const ordinals = entry.docIds.map(docId => resolver.toInternal(docId) ?? -1)
    patternIndexOf(state.patternIndexes, fieldPath).addArrays(decoded, position => ordinals[position])
  }
}
