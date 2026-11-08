import { prepareFrozenPublication } from '../../core/frozen-writes/publication'
import type { FrozenLiveCounts } from '../../core/partition/frozen/live-counts'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import type { FrozenStringRemoval } from '../../core/partition/frozen/removal-strings'
import type { FrozenTokenTable } from '../../core/partition/frozen/token-table'
import type { FrozenTombstones } from '../../core/partition/frozen/tombstones'
import { TermLookup } from '../../core/term-table/lookup'
import type { NativeTermDictionary } from '../../vector/native/types/terms'
import { createPagedExpansionSource } from './expansion-source'
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
  const prepareTerms = createRemovalReader(file, removalOffsets, removals, table.size)
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

  function documentFrequency(sortedIndex: number): number {
    return lookups.frequency(dictionary, sortedIndex)
  }

  return {
    expansionSource: expansion.read,
    dictionary(): NativeTermDictionary {
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
      return removedOccurrences[sortedIndex]
    },

    docFrequencies(): Readonly<Record<string, number>> {
      const frequencies: Record<string, number> = Object.create(null)
      for (let at = 0; at < table.size; at++) {
        const documents = documentFrequency(at)
        if (documents > 0) frequencies[table.tokenAt(at)] = documents
      }
      return frequencies
    },

    prepareRemoval(ordinal: number, strings?: FrozenStringRemoval): () => void {
      const removalTerms = prepareTerms(ordinal)
      const segment = { ...expansion.frozen, ...strings, removalTerms }
      const state =
        strings === undefined
          ? expansion.state
          : {
              ...expansion.state,
              removedSurfaces: strings.removedSurfaces,
              removedSpellings: strings.removedSpellings,
            }
      const subtractTerms = prepareFrozenPublication(segment, state, ordinal, strings?.fields ?? [])
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
      return removedDocuments.byteLength + removedOccurrences.byteLength + expansion.bytes()
    },
  }
}
