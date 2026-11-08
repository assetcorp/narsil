import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import type { FrozenTokenTable } from '../../core/partition/frozen/token-table'
import type { FrozenTombstones } from '../../core/partition/frozen/tombstones'
import type { NativeExpansionSegment } from '../../vector/native/types/expansion'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import { loadFailed } from './format'
import type { PagedFile, SectionReader } from './section-file'
import { readPagedTotals } from './totals'

const NUMBER_BYTES = 8

export function createPagedExpansionSource(
  file: PagedFile,
  snapshot: PagedSegmentSnapshot,
  table: FrozenTokenTable,
  tombstones: FrozenTombstones,
  removedDocuments: Uint32Array,
  removedOccurrences: Float64Array,
  totals: SectionReader,
) {
  const words = new Uint32Array(0)
  const shorts = new Uint16Array(0)
  const partialFields = new Uint8Array(snapshot.fieldNames.length)
  let occurrences: Float64Array | null = null

  const frozen: NativeFrozenSegment = {
    terms: { text: table.data.blob, offsets: table.data.offsets, counts: table.data.documentFrequencies },
    payloadSlots: table.data.payloadSlots,
    postingOffsets: snapshot.postingOffsets,
    postingDocuments: words,
    postingFrequencies: shorts,
    postingFields: shorts,
    partialFields,
    documentCount: snapshot.documentCount,
    surfaces: null,
    spellings: null,
    spellingTokens: words,
    removalIndex: null,
  }
  const state: NativeFrozenSegmentState = {
    tombstones: tombstones.bits,
    tombstoneCount: tombstones.count,
    removedDocuments,
    removedOccurrences,
    removedSurfaces: words,
    removedSpellings: words,
  }

  return {
    frozen,
    state,
    read(): NativeExpansionSegment {
      if (occurrences === null) {
        if (totals.length !== table.size * NUMBER_BYTES)
          loadFailed(`The term totals of "${snapshot.key}" have the wrong length`)
        const values = new Float64Array(table.size)
        readPagedTotals(file, totals, 0, values, new BigUint64Array(3))
        occurrences = values
      }
      return {
        growing: null,
        frozen,
        state,
        occurrences,
      }
    },
    bytes: () => partialFields.byteLength + (occurrences?.byteLength ?? 0),
  }
}
