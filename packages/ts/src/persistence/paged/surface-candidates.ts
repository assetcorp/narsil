import type { SurfaceTableReader } from '../../core/partition/frozen/surface-slot'
import type { SurfaceTableData } from '../../core/partition/frozen/surface-table'
import type { SurfaceFormCandidate } from '../../core/surface-registry'

const surfaceDecoder = new TextDecoder()
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

export function createSurfaceTableReader(read: () => SurfaceTableData | null): SurfaceTableReader {
  let table: SurfaceTableData | null | undefined

  return {
    candidatesForPrefix(prefix) {
      if (table === undefined) table = read()
      return table === null ? [] : surfaceCandidatesInTable(table, prefix)
    },
    heldBytes() {
      if (table === undefined || table === null) return 0
      return table.blob.byteLength + table.offsets.byteLength + table.counts.byteLength
    },
  }
}
