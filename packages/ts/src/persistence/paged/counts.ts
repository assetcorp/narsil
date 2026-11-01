import type { FrozenLiveCounts } from '../../core/partition/frozen/live-counts'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import type { FrozenTokenTable } from '../../core/partition/frozen/token-table'
import type { FrozenTombstones } from '../../core/partition/frozen/tombstones'
import { loadFailed } from './format'
import type { SectionReader } from './section-file'

const VALUE_BYTES = 4

export function createPagedLiveCounts(
  snapshot: PagedSegmentSnapshot,
  table: FrozenTokenTable,
  tombstones: FrozenTombstones,
  removalOffsets: SectionReader,
  removals: SectionReader,
): FrozenLiveCounts {
  let removedDocuments: Uint32Array | null = null
  let removedOccurrences: Float64Array | null = null
  let lengths: Record<string, number> | null = null

  function documentFrequency(sortedIndex: number): number {
    const held = table.documentFrequencyAt(sortedIndex)
    return removedDocuments === null ? held : held - removedDocuments[sortedIndex]
  }

  function subtractTerms(ordinal: number): void {
    const bounds = removalOffsets.bytesAt(ordinal * VALUE_BYTES, VALUE_BYTES * 2)
    const boundsView = new DataView(bounds.buffer, bounds.byteOffset, bounds.byteLength)
    const from = boundsView.getUint32(0, true)
    const to = boundsView.getUint32(VALUE_BYTES, true)
    if (to < from || to * VALUE_BYTES > removals.length || from % 2 !== 0 || to % 2 !== 0) {
      loadFailed(`The removal entry of document ${ordinal} of "${snapshot.key}" leaves its list`, { ordinal })
    }
    const entry = removals.bytesAt(from * VALUE_BYTES, (to - from) * VALUE_BYTES)
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
    removedDocuments ??= new Uint32Array(table.size)
    removedOccurrences ??= new Float64Array(table.size)
    for (let at = 0; at + VALUE_BYTES * 2 <= entry.byteLength; at += VALUE_BYTES * 2) {
      const token = view.getUint32(at, true)
      if (token >= table.size) {
        loadFailed(`The removal entry of document ${ordinal} of "${snapshot.key}" names token ${token}`, { ordinal })
      }
      removedDocuments[token] += 1
      removedOccurrences[token] += view.getUint32(at + VALUE_BYTES, true)
    }
  }

  return {
    totalDocuments(): number {
      return snapshot.documentCount - tombstones.size
    },

    totalFieldLengths(): Readonly<Record<string, number>> {
      return lengths ?? snapshot.totalFieldLengths
    },

    documentFrequency,

    removedOccurrences(sortedIndex: number): number {
      return removedOccurrences === null ? 0 : removedOccurrences[sortedIndex]
    },

    docFrequencies(): Readonly<Record<string, number>> {
      const frequencies: Record<string, number> = Object.create(null)
      for (let at = 0; at < table.size; at++) {
        const documents = documentFrequency(at)
        if (documents > 0) frequencies[table.tokenAt(at)] = documents
      }
      return frequencies
    },

    subtractRemoved(ordinal: number): void {
      lengths ??= { ...snapshot.totalFieldLengths }
      for (let field = 0; field < snapshot.fieldLengthNames.length; field++) {
        lengths[snapshot.fieldLengthNames[field]] -= snapshot.fieldLengthColumns[field][ordinal]
      }
      subtractTerms(ordinal)
    },

    bytes(): number {
      return (removedDocuments?.byteLength ?? 0) + (removedOccurrences?.byteLength ?? 0)
    },
  }
}
