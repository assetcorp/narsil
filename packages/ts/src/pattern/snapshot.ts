import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type { PatternIndexArrays, PatternIndexReader } from '../core/pattern-index/types'
import { ErrorCodes, NarsilError } from '../errors'
import type { SerializedPatternIndex } from '../types/internal'

function loadFailed(fieldPath: string, problem: string): NarsilError {
  return new NarsilError(
    ErrorCodes.PERSISTENCE_LOAD_FAILED,
    `The pattern index of field "${fieldPath}" in this partition is corrupt: ${problem}`,
    { field: fieldPath },
  )
}

export function serializePatternIndex(
  fieldPath: string,
  index: PatternIndexReader,
  toExternal: (ordinal: number) => string | undefined,
): SerializedPatternIndex {
  const arrays = index.toArrays(fieldPath, null)
  const positionOf = new Map<number, number>()
  const docIds: string[] = []
  for (const ordinal of arrays.docIds) {
    const externalId = toExternal(ordinal)
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

function appendRunCodePoints(fieldPath: string, key: string, out: number[]): void {
  const start = out.length
  for (const character of key) out.push(character.codePointAt(0) ?? 0)
  const count = out.length - start
  if (count !== PATTERN_RUN_CODE_POINTS) {
    throw loadFailed(
      fieldPath,
      `the key "${key}" holds ${count} code points, while each key must hold ${PATTERN_RUN_CODE_POINTS}`,
    )
  }
}

function requirePositions(fieldPath: string, key: string, list: unknown, documentCount: number): number[] {
  if (!Array.isArray(list)) throw loadFailed(fieldPath, `the run "${key}" must map to a list of positions`)
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

function requireDistinctDocuments(fieldPath: string, docIds: readonly string[]): void {
  const seen = new Set<string>()
  for (const docId of docIds) {
    if (seen.has(docId)) throw loadFailed(fieldPath, `the document list names "${docId}" twice`)
    seen.add(docId)
  }
}

export function decodePatternIndex(fieldPath: string, entry: SerializedPatternIndex): PatternIndexArrays {
  requireDistinctDocuments(fieldPath, entry.docIds)
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
