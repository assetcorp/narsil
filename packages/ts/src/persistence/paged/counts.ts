import { createFrozenRemovals, TermLookup } from '#platform/storage-host'
import type { FrozenStringRemoval } from '../../core/frozen-writes/removal-strings'
import type { FrozenPagedRemovals } from '../../core/frozen-writes/types'
import type { FrozenLiveCounts } from '../../core/partition/frozen/live-counts'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import type { FrozenTokenTable } from '../../core/partition/frozen/token-table'
import type { FrozenTombstones } from '../../core/partition/frozen/tombstones'
import type { NativeTermDictionary } from '../../vector/native/types/terms'
import { createPagedExpansionSource } from './expansion-source'
import { failNativePage } from './native-file'
import { createRemovalReader } from './removals'
import type { PagedFile, SectionReader } from './section-file'

export function createPagedLiveCounts(
  file: PagedFile,
  snapshot: PagedSegmentSnapshot,
  table: FrozenTokenTable,
  tombstones: FrozenTombstones,
  removalOffsets: SectionReader,
  removals: SectionReader,
  totals: SectionReader,
): FrozenLiveCounts {
  const removedDocuments = new Uint32Array(table.size)
  const removedOccurrences = new Float64Array(table.size)
  const dictionary = table.dictionary(removedDocuments)
  const lookups = new TermLookup()
  const fault = new BigUint64Array(3)
  const paged: FrozenPagedRemovals = {
    native() {
      const offsets = removalOffsets.native
      const values = removals.native
      if (offsets === null || values === null || file.native === null) return null
      return { offsets, values, cache: file.cache.pageCache(), fault }
    },
    read: createRemovalReader(file, removalOffsets, removals, table.size),
    fail(status) {
      const section = fault[1] === removalOffsets.native?.offset ? 'removalOffsets' : 'removals'
      return failNativePage(status, file.path, section, fault[2])
    },
  }
  let lengths: Record<string, number> | null = null
  const expansion = createPagedExpansionSource(
    file,
    snapshot,
    table,
    tombstones,
    removedDocuments,
    removedOccurrences,
    totals,
  )
  const pending = createFrozenRemovals(expansion.frozen, expansion.state, paged)

  function documentFrequency(sortedIndex: number): number {
    pending.settle()
    return lookups.frequency(dictionary, sortedIndex)
  }

  return {
    expansionSource() {
      pending.settle()
      return expansion.read()
    },
    pendingRemovals: pending.pending,
    settleRemovals: pending.settle,
    dictionary(): NativeTermDictionary {
      pending.settle()
      return dictionary
    },
    totalDocuments(): number {
      return snapshot.documentCount - tombstones.size
    },

    totalFieldLengths(): Readonly<Record<string, number>> {
      return lengths ?? snapshot.totalFieldLengths
    },

    documentFrequency,

    removedOccurrences(sortedIndex: number): number {
      pending.settle()
      return removedOccurrences[sortedIndex]
    },

    docFrequencies(): Readonly<Record<string, number>> {
      pending.settle()
      const frequencies: Record<string, number> = Object.create(null)
      for (let at = 0; at < table.size; at++) {
        const documents = documentFrequency(at)
        if (documents > 0) frequencies[table.tokenAt(at)] = documents
      }
      return frequencies
    },

    prepareRemoval(ordinal: number, strings?: FrozenStringRemoval): () => void {
      const subtractTerms = pending.prepare(ordinal, strings?.fields ?? [], strings)
      const nextLengths = lengths ?? { ...snapshot.totalFieldLengths }
      return () => {
        lengths ??= nextLengths
        for (let field = 0; field < snapshot.fieldLengthNames.length; field++) {
          lengths[snapshot.fieldLengthNames[field]] -= snapshot.fieldLengthColumns[field][ordinal]
        }
        subtractTerms()
      }
    },

    bytes(): number {
      return removedDocuments.byteLength + removedOccurrences.byteLength + expansion.bytes() + pending.bytes()
    },
  }
}
