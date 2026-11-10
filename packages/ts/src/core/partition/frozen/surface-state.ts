import type { NativeFrozenStrings } from '../../../vector/native/types/frozen-segments'
import { findEntry } from '../../frozen-writes/strings'
import type { SurfaceRegistry } from '../../surface-registry'
import { codePointOrder, encodeStringBlob } from './string-blob'

export function createSurfaceRemovalState(registry: SurfaceRegistry) {
  const surfaces: string[] = []
  const tokens: string[] = []
  const entryCounts: number[] = []
  registry.forEachForm((surface, token, count) => {
    surfaces.push(surface)
    tokens.push(token)
    entryCounts.push(count)
  })
  const order = codePointOrder(surfaces)
  const surfaceThenToken: string[] = new Array(order.length * 2)
  const counts = new Uint32Array(order.length)
  for (let entry = 0; entry < order.length; entry++) {
    const from = order[entry]
    surfaceThenToken[entry * 2] = surfaces[from]
    surfaceThenToken[entry * 2 + 1] = tokens[from]
    counts[entry] = entryCounts[from]
  }
  const { blob, offsets } = encodeStringBlob(surfaceThenToken)
  const table: NativeFrozenStrings = { text: blob, offsets, counts }
  const removed = new Uint32Array(counts.length)
  return {
    table,
    removed,
    subtract(spelling: string, count: number): void {
      const entry = findEntry(table, spelling, 2)
      if (entry >= 0) removed[entry] = Math.min(table.counts[entry], removed[entry] + count)
    },
    bytes(): number {
      return table.text.byteLength + table.offsets.byteLength + table.counts.byteLength + removed.byteLength
    },
  }
}
