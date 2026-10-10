import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type { PatternHost, PatternIndexArrays, PatternIndexWriter } from '../core/pattern-index/types'
import {
  DOCUMENT_ENTRY_BYTES,
  RUN_ENTRY_OVERHEAD_BYTES,
  RUN_LIST_COMPACTION_FRACTION,
  RUN_LIST_INITIAL_CAPACITY,
} from './constants'
import { buildArrays, EMPTY_POSTINGS, type RunSource, sortedRunOrder } from './runs-arrays'
import { collectRunKeys, forEachTextValue, holdsTextValue, runKey, runKeyCodePoints } from './text'

interface RunList {
  ids: Uint32Array
  length: number
  removed: Set<number> | null
  ordered: boolean
}

function createRunList(): RunList {
  return { ids: new Uint32Array(RUN_LIST_INITIAL_CAPACITY), length: 0, removed: null, ordered: true }
}

function compactRemoved(list: RunList): void {
  const removed = list.removed
  if (removed === null) return
  let kept = 0
  for (let at = 0; at < list.length; at++) {
    const ordinal = list.ids[at]
    if (removed.has(ordinal)) continue
    list.ids[kept++] = ordinal
  }
  list.length = kept
  list.removed = null
}

function compactAndSort(list: RunList): void {
  compactRemoved(list)
  if (!list.ordered) {
    list.ids.subarray(0, list.length).sort()
    list.ordered = true
  }
}

export function createGrowingPatternIndex(host: PatternHost): PatternIndexWriter {
  const runs = new Map<string, RunList>()
  const documents = new Set<number>()
  let documentsCache: Uint32Array | null = null
  let listBytes = 0
  const folded: number[] = []

  function runKeysOf(value: unknown): Set<string> {
    const keys = new Set<string>()
    forEachTextValue(value, text => {
      folded.length = 0
      host.appendFolded(text, folded)
      collectRunKeys(folded, keys)
    })
    return keys
  }

  function grow(list: RunList): void {
    const next = new Uint32Array(list.ids.length * 2)
    next.set(list.ids.subarray(0, list.length))
    listBytes += next.byteLength - list.ids.byteLength
    list.ids = next
  }

  function listFor(key: string): RunList {
    let list = runs.get(key)
    if (list === undefined) {
      list = createRunList()
      listBytes += list.ids.byteLength
      runs.set(key, list)
    }
    return list
  }

  function append(list: RunList, ordinal: number): void {
    if (list.removed?.delete(ordinal)) return
    if (list.length === list.ids.length) grow(list)
    if (list.length > 0 && list.ids[list.length - 1] > ordinal) list.ordered = false
    list.ids[list.length++] = ordinal
  }

  function dropIfEmpty(key: string, list: RunList): void {
    if (list.length > 0) return
    listBytes -= list.ids.byteLength
    runs.delete(key)
  }

  function markRemoved(key: string, list: RunList, ordinal: number): void {
    if (list.removed === null) list.removed = new Set()
    list.removed.add(ordinal)
    if (list.removed.size < list.length * RUN_LIST_COMPACTION_FRACTION) return
    compactRemoved(list)
    dropIfEmpty(key, list)
  }

  function settledPostings(key: string): Uint32Array {
    const list = runs.get(key)
    if (list === undefined) return EMPTY_POSTINGS
    compactAndSort(list)
    if (list.length === 0) {
      dropIfEmpty(key, list)
      return EMPTY_POSTINGS
    }
    return list.ids.subarray(0, list.length)
  }

  function sortedDocuments(): Uint32Array {
    if (documentsCache === null) {
      documentsCache = Uint32Array.from(documents).sort()
    }
    return documentsCache
  }

  function runSource(): RunSource {
    const keys: string[] = []
    const lists: Uint32Array[] = []
    for (const key of [...runs.keys()]) {
      const postings = settledPostings(key)
      if (postings.length === 0) continue
      keys.push(key)
      lists.push(postings)
    }
    const codePoints = new Uint32Array(keys.length * PATTERN_RUN_CODE_POINTS)
    for (let run = 0; run < keys.length; run++) {
      runKeyCodePoints(keys[run], codePoints, run * PATTERN_RUN_CODE_POINTS)
    }
    return { count: keys.length, codePoints, postingsAt: run => lists[run] }
  }

  return {
    add(ordinal: number, value: unknown): void {
      if (!holdsTextValue(value)) return
      documents.add(ordinal)
      documentsCache = null
      for (const key of runKeysOf(value)) append(listFor(key), ordinal)
    },

    remove(ordinal: number, value: unknown): void {
      if (!holdsTextValue(value)) return
      if (documents.delete(ordinal)) documentsCache = null
      for (const key of runKeysOf(value)) {
        const list = runs.get(key)
        if (list !== undefined) markRemoved(key, list, ordinal)
      }
    },

    addArrays(arrays: PatternIndexArrays, mapOrdinal: (ordinal: number) => number): void {
      for (const ordinal of arrays.docIds) {
        const mapped = mapOrdinal(ordinal)
        if (mapped < 0) continue
        documents.add(mapped)
        documentsCache = null
      }
      const runCount = arrays.offsets.length - 1
      for (let run = 0; run < runCount; run++) {
        const at = run * PATTERN_RUN_CODE_POINTS
        const key = runKey(arrays.runs[at], arrays.runs[at + 1], arrays.runs[at + 2])
        const list = listFor(key)
        for (let posting = arrays.offsets[run]; posting < arrays.offsets[run + 1]; posting++) {
          const mapped = mapOrdinal(arrays.postings[posting])
          if (mapped >= 0) append(list, mapped)
        }
        dropIfEmpty(key, list)
      }
    },

    clear(): void {
      runs.clear()
      documents.clear()
      documentsCache = null
      listBytes = 0
    },

    documents: sortedDocuments,

    postings(first: number, second: number, third: number): Uint32Array {
      return settledPostings(runKey(first, second, third))
    },

    toArrays(fieldPath: string, remap: Int32Array | null): PatternIndexArrays {
      const source = runSource()
      return buildArrays(fieldPath, sortedDocuments(), source, sortedRunOrder(source.codePoints, source.count), remap)
    },

    bytes(): number {
      return listBytes + runs.size * RUN_ENTRY_OVERHEAD_BYTES + documents.size * DOCUMENT_ENTRY_BYTES
    },
  }
}
