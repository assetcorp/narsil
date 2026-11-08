import { fuse } from '#platform/fusion-core'
import { compareCodePoints } from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import { releaseFusionMemory, takeFusionMemory } from './fusion-memory'

interface FusionEntry {
  docId: string
  score?: number | null
}

const SURROGATE_UNIT = /[\ud800-\udfff]/

function rankDistinctPrefixes(entries: readonly FusionEntry[], idRanks: Uint32Array): boolean {
  const prefixes = new Set<number>()
  for (let key = 0; key < entries.length; key++) {
    const id = entries[key].docId
    const first = id.charCodeAt(0)
    const second = id.charCodeAt(1)
    const third = id.charCodeAt(2)
    const fourth = id.charCodeAt(3)
    if ((first | second | third | fourth) > 0xff) return false
    const prefix = ((first << 24) | (second << 16) | (third << 8) | fourth) >>> 0
    prefixes.add(prefix)
    if (prefixes.size !== key + 1) return false
    idRanks[key] = prefix
  }
  return true
}

export function fuseRankings<Entry extends FusionEntry, Result>(
  text: readonly Entry[],
  vector: readonly Entry[],
  strategy: number,
  k: number,
  alpha: number,
  project: (entry: Entry, score: number) => Result,
): Result[] {
  const memory = takeFusionMemory(text.length + vector.length)
  try {
    return fuseWithMemory(text, vector, strategy, k, alpha, memory, project)
  } finally {
    releaseFusionMemory(memory)
  }
}

function fuseWithMemory<Entry extends FusionEntry, Result>(
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
  const count = entries.length
  const capacity = text.length + vector.length
  const idRanks = memory.keys(2, capacity)
  if (!rankDistinctPrefixes(entries, idRanks)) {
    const orderedIds = Array.from(positions.keys())
    const needsCodePoints = orderedIds.some(id => SURROGATE_UNIT.test(id))
    orderedIds.sort(needsCodePoints ? compareCodePoints : undefined)
    for (let rank = 0; rank < count; rank++) {
      const key = positions.get(orderedIds[rank])
      if (key !== undefined) idRanks[key] = rank
    }
  }
  const keys = memory.keys(3, capacity)
  const scores = memory.scores(2, capacity)
  const found = fuse(strategy, k, alpha, textKeys, textScores, vectorKeys, vectorScores, idRanks, keys, scores)
  if (found < 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The hybrid rankings cannot be fused', { status: found })
  }
  const result = new Array<Result>(found)
  for (let position = 0; position < found; position++) {
    result[position] = project(entries[keys[position]], scores[position])
  }
  return result
}
