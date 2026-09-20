import { compareCodePoints } from '../../ordering'
import { codePointOrder, encodeStringBlob } from './string-blob'

export interface ExternalIdTable {
  readonly count: number
  /** The table holds this many bytes, read from its arrays where it keeps the ids encoded. */
  readonly bytes: number
  idAt(ordinal: number): string
  ordinalOf(docId: string): number
  collectSortedIds(excluded: (ordinal: number) => boolean): string[]
}

export interface ExternalIdTableData {
  blob: Uint8Array
  offsets: Uint32Array
  sortedOrdinals: Uint32Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeExternalIdTableData(docIds: readonly string[]): ExternalIdTableData {
  const { blob, offsets } = encodeStringBlob(docIds)
  return { blob, offsets, sortedOrdinals: Uint32Array.from(codePointOrder(docIds)) }
}

function compareBytes(blob: Uint8Array, start: number, end: number, query: Uint8Array): number {
  const length = end - start
  const shared = length < query.length ? length : query.length
  for (let i = 0; i < shared; i++) {
    const diff = blob[start + i] - query[i]
    if (diff !== 0) return diff
  }
  return length - query.length
}

export function wrapExternalIdTable(data: ExternalIdTableData): ExternalIdTable {
  const { blob, offsets, sortedOrdinals } = data
  const count = sortedOrdinals.length
  const decoded: Array<string | undefined> = new Array(count)

  function idAt(ordinal: number): string {
    let id = decoded[ordinal]
    if (id === undefined) {
      id = decoder.decode(blob.subarray(offsets[ordinal], offsets[ordinal + 1]))
      decoded[ordinal] = id
    }
    return id
  }

  return {
    count,
    bytes: blob.byteLength + offsets.byteLength + sortedOrdinals.byteLength,

    idAt,

    ordinalOf(docId: string): number {
      const query = encoder.encode(docId)
      let lo = 0
      let hi = count
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        const ordinal = sortedOrdinals[mid]
        if (compareBytes(blob, offsets[ordinal], offsets[ordinal + 1], query) < 0) lo = mid + 1
        else hi = mid
      }
      if (lo >= count) return -1
      const ordinal = sortedOrdinals[lo]
      return compareBytes(blob, offsets[ordinal], offsets[ordinal + 1], query) === 0 ? ordinal : -1
    },

    collectSortedIds(excluded: (ordinal: number) => boolean): string[] {
      const ids: string[] = []
      for (let position = 0; position < count; position++) {
        const ordinal = sortedOrdinals[position]
        if (excluded(ordinal)) continue
        ids.push(idAt(ordinal))
      }
      return ids
    },
  }
}

export function buildExternalIdTable(docIds: readonly string[]): ExternalIdTable {
  const ordinals = new Map<string, number>()
  let characters = 0
  for (let ordinal = 0; ordinal < docIds.length; ordinal++) {
    ordinals.set(docIds[ordinal], ordinal)
    characters += docIds[ordinal].length
  }
  let sortedIds: readonly string[] | null = null

  return {
    count: docIds.length,
    bytes: characters,

    idAt(ordinal: number): string {
      return docIds[ordinal]
    },

    ordinalOf(docId: string): number {
      return ordinals.get(docId) ?? -1
    },

    collectSortedIds(excluded: (ordinal: number) => boolean): string[] {
      if (sortedIds === null) {
        const ids = [...docIds]
        ids.sort(compareCodePoints)
        sortedIds = ids
      }
      const kept: string[] = []
      for (const docId of sortedIds) {
        const ordinal = ordinals.get(docId)
        if (ordinal === undefined || excluded(ordinal)) continue
        kept.push(docId)
      }
      return kept
    },
  }
}
