import { compareCodePoints } from '../../ordering'
import { encodeStringBlob } from '../frozen/string-blob'
import type { FrozenTokenTable } from '../frozen/token-table'
import { PARTIAL_WORD_RUN_CODE_POINTS } from './constants'
import { countSpelling, type PartialSpellings, type SpellingCounts } from './spellings'
import { codePointsOf, partialWordProbe, runKeyAt, utf8CodePointCount, utf8Contains } from './text'
import type { PartialWordProbe, PartialWordTableData, PartialWordTableReader, PartialWordVisitor } from './types'

const decoder = new TextDecoder()

interface SpellingEntry {
  spelling: string
  tokenIndex: number
  count: number
}

function compareEntries(left: SpellingEntry, right: SpellingEntry): number {
  return compareCodePoints(left.spelling, right.spelling) || left.tokenIndex - right.tokenIndex
}

function orderedEntriesOf(source: PartialSpellings, tokenTable: FrozenTokenTable): SpellingEntry[] {
  const entries: SpellingEntry[] = []
  for (let at = 0; at < source.tokens.length; at++) {
    if (source.counts[at] <= 0) continue
    const tokenIndex = tokenTable.find(source.tokens[at])
    if (tokenIndex >= 0) entries.push({ spelling: source.spellings[at], tokenIndex, count: source.counts[at] })
  }
  entries.sort(compareEntries)
  const distinct: SpellingEntry[] = []
  for (const entry of entries) {
    const last = distinct[distinct.length - 1]
    if (last !== undefined && compareEntries(last, entry) === 0) last.count += entry.count
    else distinct.push(entry)
  }
  return distinct
}

export function buildPartialWordTable(source: PartialSpellings, tokenTable: FrozenTokenTable): PartialWordTableData {
  const spellings: string[] = []
  const spellingTokens: number[] = []
  const spellingCounts: number[] = []
  const runLists = new Map<string, number[]>()

  const addSpelling = (spelling: string, tokenIndex: number, count: number): void => {
    const points = codePointsOf(spelling)
    if (points.length <= PARTIAL_WORD_RUN_CODE_POINTS) return
    const entry = spellings.length
    spellings.push(spelling)
    spellingTokens.push(tokenIndex)
    spellingCounts.push(count)
    for (let at = 0; at + PARTIAL_WORD_RUN_CODE_POINTS <= points.length; at++) {
      const key = runKeyAt(points, at)
      const list = runLists.get(key)
      if (list === undefined) runLists.set(key, [entry])
      else if (list[list.length - 1] !== entry) list.push(entry)
    }
  }

  for (const entry of orderedEntriesOf(source, tokenTable)) addSpelling(entry.spelling, entry.tokenIndex, entry.count)

  const runKeys = [...runLists.keys()].sort(compareCodePoints)
  const runs = new Uint32Array(runKeys.length * PARTIAL_WORD_RUN_CODE_POINTS)
  const runOffsets = new Uint32Array(runKeys.length + 1)
  let memberCount = 0
  for (const key of runKeys) memberCount += runLists.get(key)?.length ?? 0
  const runEntries = new Uint32Array(memberCount)
  let cursor = 0
  for (let run = 0; run < runKeys.length; run++) {
    const points = codePointsOf(runKeys[run])
    runs.set(points, run * PARTIAL_WORD_RUN_CODE_POINTS)
    for (const entry of runLists.get(runKeys[run]) ?? []) runEntries[cursor++] = entry
    runOffsets[run + 1] = cursor
  }

  const spellingBlob = encodeStringBlob(spellings)
  return {
    fields: [...source.fields],
    spellings: spellingBlob.blob,
    spellingOffsets: spellingBlob.offsets,
    spellingTokens: Uint32Array.from(spellingTokens),
    spellingCounts: Uint32Array.from(spellingCounts),
    runs,
    runOffsets,
    runEntries,
  }
}

export function countTableSpellings(
  counts: SpellingCounts,
  table: PartialWordTableData,
  tokenTable: FrozenTokenTable,
): void {
  const { spellings, spellingOffsets, spellingTokens, spellingCounts } = table
  for (let entry = 0; entry < spellingTokens.length; entry++) {
    const spelling = decoder.decode(spellings.subarray(spellingOffsets[entry], spellingOffsets[entry + 1]))
    countSpelling(counts, tokenTable.tokenAt(spellingTokens[entry]), spelling, spellingCounts[entry])
  }
}

function findRun(runs: Uint32Array, first: number, second: number, third: number): number {
  let low = 0
  let high = runs.length / PARTIAL_WORD_RUN_CODE_POINTS
  while (low < high) {
    const middle = (low + high) >>> 1
    const at = middle * PARTIAL_WORD_RUN_CODE_POINTS
    const difference = runs[at] - first || runs[at + 1] - second || runs[at + 2] - third
    if (difference === 0) return middle
    if (difference < 0) low = middle + 1
    else high = middle
  }
  return -1
}

export function partialWordTableBytes(table: PartialWordTableData): number {
  return (
    table.spellings.byteLength +
    table.spellingOffsets.byteLength +
    table.spellingTokens.byteLength +
    table.spellingCounts.byteLength +
    table.runs.byteLength +
    table.runOffsets.byteLength +
    table.runEntries.byteLength
  )
}

export function readPartialWordTable(
  table: PartialWordTableData,
  tokenTable: FrozenTokenTable,
  removedCounts: ReadonlyMap<number, number>,
): PartialWordTableReader {
  const { spellings, spellingOffsets, spellingTokens, spellingCounts, runs, runOffsets, runEntries } = table

  function narrowestRun(points: readonly number[]): number {
    let narrowest = -1
    let narrowestLength = Number.POSITIVE_INFINITY
    for (let at = 0; at + PARTIAL_WORD_RUN_CODE_POINTS <= points.length; at++) {
      const run = findRun(runs, points[at], points[at + 1], points[at + 2])
      if (run < 0) return -1
      const length = runOffsets[run + 1] - runOffsets[run]
      if (length < narrowestLength) {
        narrowest = run
        narrowestLength = length
      }
    }
    return narrowest
  }

  return {
    forEachContaining(probe: PartialWordProbe, visit: PartialWordVisitor): void {
      if (probe.codePoints.length < PARTIAL_WORD_RUN_CODE_POINTS) return
      const run = narrowestRun(probe.codePoints)
      if (run < 0) return
      for (let member = runOffsets[run]; member < runOffsets[run + 1]; member++) {
        const entry = runEntries[member]
        const start = spellingOffsets[entry]
        const end = spellingOffsets[entry + 1]
        if (end - start <= probe.utf8.length) continue
        if ((removedCounts.get(entry) ?? 0) >= spellingCounts[entry]) continue
        if (!utf8Contains(spellings, start, end, probe.utf8)) continue
        const length = utf8CodePointCount(spellings, start, end)
        if (length <= probe.codePoints.length) continue
        visit(tokenTable.tokenAt(spellingTokens[entry]), length)
      }
    },

    entryOf(spelling: string): number {
      const probe = partialWordProbe(spelling)
      if (probe.codePoints.length <= PARTIAL_WORD_RUN_CODE_POINTS) return -1
      const run = narrowestRun(probe.codePoints)
      if (run < 0) return -1
      let exhausted = -1
      for (let member = runOffsets[run]; member < runOffsets[run + 1]; member++) {
        const entry = runEntries[member]
        const start = spellingOffsets[entry]
        const end = spellingOffsets[entry + 1]
        if (end - start !== probe.utf8.length || !utf8Contains(spellings, start, end, probe.utf8)) continue
        if ((removedCounts.get(entry) ?? 0) < spellingCounts[entry]) return entry
        if (exhausted < 0) exhausted = entry
      }
      return exhausted
    },

    bytes(): number {
      return partialWordTableBytes(table)
    },
  }
}
