import type { SurfaceTableReader } from '../../core/partition/frozen/surface-slot'
import type { SurfaceTableData } from '../../core/partition/frozen/surface-table'
import type { SurfaceFormCandidate } from '../../core/surface-registry'

const surfaceDecoder = new TextDecoder('utf-8', { ignoreBOM: true })
const surfaceEncoder = new TextEncoder()

function surfaceCandidatesInTable(table: SurfaceTableData, prefix: string): SurfaceFormCandidate[] {
  if (prefix.length === 0) return []
  const wanted = surfaceEncoder.encode(prefix)
  const { blob, offsets, counts } = table
  const found: SurfaceFormCandidate[] = []
  for (let entry = 0; entry < counts.length; entry++) {
    const start = offsets[2 * entry]
    const tokenStart = offsets[2 * entry + 1]
    if (tokenStart - start < wanted.length) continue
    let at = 0
    while (at < wanted.length && blob[start + at] === wanted[at]) at += 1
    if (at < wanted.length || counts[entry] === 0) continue
    found.push({
      surface: surfaceDecoder.decode(blob.subarray(start, tokenStart)),
      token: surfaceDecoder.decode(blob.subarray(tokenStart, offsets[2 * entry + 2])),
      occurrences: counts[entry],
    })
  }
  return found
}

function compareSurfaceAt(table: SurfaceTableData, entry: number, wanted: Uint8Array): number {
  const start = table.offsets[2 * entry]
  const length = table.offsets[2 * entry + 1] - start
  const shared = Math.min(length, wanted.length)
  for (let at = 0; at < shared; at++) {
    const difference = table.blob[start + at] - wanted[at]
    if (difference !== 0) return difference
  }
  return length - wanted.length
}

function surfacesAscend(table: SurfaceTableData): boolean {
  for (let entry = 1; entry < table.counts.length; entry++) {
    const start = table.offsets[2 * entry]
    if (compareSurfaceAt(table, entry - 1, table.blob.subarray(start, table.offsets[2 * entry + 1])) >= 0) return false
  }
  return true
}

function surfaceEntryOf(table: SurfaceTableData, wanted: Uint8Array, ascending: boolean): number {
  if (!ascending) {
    for (let entry = 0; entry < table.counts.length; entry++)
      if (compareSurfaceAt(table, entry, wanted) === 0) return entry
    return -1
  }
  let low = 0
  let high = table.counts.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const order = compareSurfaceAt(table, middle, wanted)
    if (order === 0) return middle
    if (order < 0) low = middle + 1
    else high = middle - 1
  }
  return -1
}

function surfaceFormInTable(
  table: SurfaceTableData,
  surface: string,
  ascending: boolean,
): SurfaceFormCandidate | undefined {
  if (surface.length === 0) return undefined
  const entry = surfaceEntryOf(table, surfaceEncoder.encode(surface), ascending)
  if (entry < 0 || table.counts[entry] === 0) return undefined
  const tokenStart = table.offsets[2 * entry + 1]
  return {
    surface,
    token: surfaceDecoder.decode(table.blob.subarray(tokenStart, table.offsets[2 * entry + 2])),
    occurrences: table.counts[entry],
  }
}

export function createSurfaceTableReader(read: () => SurfaceTableData | null): SurfaceTableReader {
  let table: SurfaceTableData | null | undefined
  let ascending: boolean | undefined

  return {
    candidatesForPrefix(prefix) {
      if (table === undefined) table = read()
      return table === null ? [] : surfaceCandidatesInTable(table, prefix)
    },
    formOf(surface) {
      if (table === undefined) table = read()
      if (table === null) return undefined
      ascending ??= surfacesAscend(table)
      return surfaceFormInTable(table, surface, ascending)
    },
    heldBytes() {
      if (table === undefined || table === null) return 0
      return table.blob.byteLength + table.offsets.byteLength + table.counts.byteLength
    },
  }
}
