import { fusionCore } from '#platform/fusion-core'
import { compareCodePoints, ErrorCodes, FUSION_TIE_INSERTION_LIMIT, NarsilError } from '#platform/vector-host'
import type { FusionCore } from './fusion-core'
import { releaseFusionMemory, takeFusionMemory } from './fusion-memory'

interface FusionEntry {
  docId: string
  score?: number | null
}

interface FusedResult {
  docId: string
  score: number | null
}

function compareFused(left: FusedResult, right: FusedResult): number {
  return (right.score ?? 0) - (left.score ?? 0) || compareCodePoints(left.docId, right.docId)
}

function fuseByRank<Entry extends FusionEntry, Result extends FusedResult>(
  lists: readonly (readonly Entry[])[],
  k: number,
  project: (entry: Entry, score: number) => Result,
): Result[] {
  const positions = new Map<string, number>()
  const results: Result[] = []
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const entry = list[rank]
      const contribution = 1 / (k + rank + 1)
      const position = positions.get(entry.docId)
      if (position === undefined) {
        positions.set(entry.docId, results.length)
        results.push(project(entry, contribution))
      } else {
        const result = results[position]
        result.score = (result.score ?? 0) + contribution
      }
    }
  }
  results.sort(compareFused)
  return results
}

function saturate(score: number): number {
  if (score > Number.MAX_VALUE) return Number.MAX_VALUE
  if (score < -Number.MAX_VALUE) return -Number.MAX_VALUE
  return score
}

function normalisedScores(entries: readonly FusionEntry[]): Map<string, number> {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    const score = saturate(entry.score ?? 0)
    if (score < min) min = score
    if (score > max) max = score
  }
  const width = max - min
  const normalised = new Map<string, number>()
  for (const entry of entries) {
    const score = saturate(entry.score ?? 0)
    if (Number.isNaN(score)) normalised.set(entry.docId, 0)
    else if (width === 0) normalised.set(entry.docId, 1)
    else if (Number.isFinite(width)) normalised.set(entry.docId, (score - min) / width)
    else normalised.set(entry.docId, (score / 2 - min / 2) / (max / 2 - min / 2))
  }
  return normalised
}

function fuseByScore<Entry extends FusionEntry, Result extends FusedResult>(
  text: readonly Entry[],
  vector: readonly Entry[],
  alpha: number,
  project: (entry: Entry, score: number) => Result,
): Result[] {
  const textScores = normalisedScores(text)
  const vectorScores = normalisedScores(vector)
  const results: Result[] = []
  const placed = new Set<string>()
  for (const list of [text, vector]) {
    for (const entry of list) {
      if (placed.has(entry.docId)) continue
      placed.add(entry.docId)
      const vectorScore = vectorScores.get(entry.docId) ?? 0
      const textScore = textScores.get(entry.docId) ?? 0
      results.push(project(entry, alpha * vectorScore + (1 - alpha) * textScore))
    }
  }
  results.sort(compareFused)
  return results
}

function insertTiesById(entries: readonly FusionEntry[], keys: Uint32Array, start: number, end: number): void {
  for (let at = start + 1; at < end; at++) {
    const key = keys[at]
    const id = entries[key].docId
    let to = at
    while (to > start && compareCodePoints(entries[keys[to - 1]].docId, id) > 0) {
      keys[to] = keys[to - 1]
      to--
    }
    keys[to] = key
  }
}

function orderTiesById(entries: readonly FusionEntry[], keys: Uint32Array, scores: Float64Array, found: number): void {
  let start = 0
  while (start < found) {
    let end = start + 1
    while (end < found && scores[end] === scores[start]) end++
    if (end - start > FUSION_TIE_INSERTION_LIMIT)
      keys.subarray(start, end).sort((left, right) => compareCodePoints(entries[left].docId, entries[right].docId))
    else if (end - start > 1) insertTiesById(entries, keys, start, end)
    start = end
  }
}

export function fuseRankings<Entry extends FusionEntry, Result extends FusedResult>(
  text: readonly Entry[],
  vector: readonly Entry[],
  strategy: number,
  k: number,
  alpha: number,
  project: (entry: Entry, score: number) => Result,
): Result[] {
  const core = fusionCore()
  if (core === undefined) {
    return strategy === 0 ? fuseByRank([text, vector], k, project) : fuseByScore(text, vector, alpha, project)
  }
  const memory = takeFusionMemory(text.length + vector.length)
  try {
    return fuseInCore(core, text, vector, strategy, k, alpha, memory, project)
  } finally {
    releaseFusionMemory(memory)
  }
}

function fuseInCore<Entry extends FusionEntry, Result>(
  core: FusionCore,
  text: readonly Entry[],
  vector: readonly Entry[],
  strategy: number,
  k: number,
  alpha: number,
  memory: ReturnType<typeof takeFusionMemory>,
  project: (entry: Entry, score: number) => Result,
): Result[] {
  const positions = new Map<string, number>()
  const entries = text.slice()
  const textKeys = memory.keys(0, text.length)
  const textScores = memory.scores(0, text.length)
  for (let position = 0; position < text.length; position++) {
    const entry = text[position]
    positions.set(entry.docId, position)
    textKeys[position] = position
    if (strategy === 1) textScores[position] = entry.score ?? 0
  }
  if (positions.size !== text.length) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The hybrid rankings cannot be fused', { status: -1 })
  }
  const vectorKeys = memory.keys(1, vector.length)
  const vectorScores = memory.scores(1, vector.length)
  for (let position = 0; position < vector.length; position++) {
    const entry = vector[position]
    let key = positions.get(entry.docId)
    if (key === undefined) {
      key = entries.length
      positions.set(entry.docId, key)
      entries.push(entry)
    }
    vectorKeys[position] = key
    if (strategy === 1) vectorScores[position] = entry.score ?? 0
  }
  const capacity = text.length + vector.length
  const idRanks = memory.keys(2, capacity)
  for (let key = 0; key < entries.length; key++) idRanks[key] = key
  const keys = memory.keys(3, capacity)
  const scores = memory.scores(2, capacity)
  const found = core.fuse(strategy, k, alpha, textKeys, textScores, vectorKeys, vectorScores, idRanks, keys, scores)
  if (found < 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The hybrid rankings cannot be fused', { status: found })
  }
  orderTiesById(entries, keys, scores, found)
  const result = new Array<Result>(found)
  for (let position = 0; position < found; position++) {
    result[position] = project(entries[keys[position]], scores[position])
  }
  return result
}
