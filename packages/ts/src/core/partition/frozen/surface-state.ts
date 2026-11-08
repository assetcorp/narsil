import type { NativeFrozenStrings } from '../../../vector/native/types/frozen-segments'
import type { SurfaceRegistry } from '../../surface-registry'
import { REMOVED_SURFACE_ENTRY_BYTES } from './constants'
import { encodeSurfaceTable } from './surface-table'

export function createSurfaceRemovalState(registry: SurfaceRegistry) {
  const forms = registry.serialize()
  const data = encodeSurfaceTable(forms)
  const table: NativeFrozenStrings = { text: data.blob, offsets: data.offsets, counts: data.counts }
  const removed = new Uint32Array(data.counts.length)
  const entries = new Map(Object.keys(forms).map((spelling, ordinal) => [spelling, ordinal]))
  return {
    table,
    removed,
    subtract(spelling: string, count: number): void {
      const entry = entries.get(spelling)
      if (entry !== undefined) removed[entry] = Math.min(table.counts[entry], removed[entry] + count)
    },
    prepareSync(spellings: readonly string[]): () => void {
      const previous = new Map<number, { spelling: string; count: number }>()
      for (const spelling of spellings) {
        const entry = entries.get(spelling)
        if (entry !== undefined && !previous.has(entry)) previous.set(entry, { spelling, count: removed[entry] })
      }
      return () => {
        for (const [entry, held] of previous) registry.subtract(held.spelling, removed[entry] - held.count)
      }
    },
    bytes(): number {
      return (
        table.text.byteLength +
        table.offsets.byteLength +
        table.counts.byteLength +
        removed.byteLength +
        entries.size * REMOVED_SURFACE_ENTRY_BYTES
      )
    },
  }
}
