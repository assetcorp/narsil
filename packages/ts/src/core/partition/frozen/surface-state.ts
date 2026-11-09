import type { NativeFrozenStrings } from '../../../vector/native/types/frozen-segments'
import { findEntry } from '../../frozen-writes/strings'
import { compareCodePoints } from '../../ordering'
import type { SurfaceRegistry } from '../../surface-registry'
import { encodeStringBlob } from './string-blob'

export function createSurfaceRemovalState(registry: SurfaceRegistry) {
  const forms = registry.serialize()
  const surfaceThenToken: string[] = []
  const entryCounts: number[] = []
  for (const surface of Object.keys(forms).sort(compareCodePoints)) {
    const value = forms[surface]
    if (!Array.isArray(value)) continue
    surfaceThenToken.push(surface, value[1])
    entryCounts.push(value[0])
  }
  const counts = Uint32Array.from(entryCounts)
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
