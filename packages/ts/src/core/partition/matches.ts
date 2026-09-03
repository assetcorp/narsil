import type { InternalSearchParams, PostingListView } from '../../types/internal'
import { bitsetHas, bitsetSet, createBitSet } from '../bitset'
import type { PartitionFilterMatches } from './filters'
import { postingColumns } from './posting-columns'
import type { PartitionReadState } from './utils'

/**
 * The documents of one partition that a full-text query matches, held as a bit
 * per ordinal. A sorted query without scoring walks the postings once to build
 * this, then streams the sort columns against it.
 *
 * @internal
 */
export interface PartitionSearchMatches extends PartitionFilterMatches {
  /** Returns the external ids of every matching document, for facet counting. */
  matchedDocIds(): Set<string>
  /**
   * Returns the matches as a bit per ordinal in this partition's ordinal
   * space, which a same-process facet count reads in place of the id set.
   */
  ordinalBitset(): Uint32Array
}

function markPostingList(
  matched: Uint32Array,
  list: PostingListView,
  fieldNames: string[],
  fields: string[] | undefined,
  filterBitset: Uint32Array | undefined,
): void {
  const { docIds, fieldNameIndices, deletedDocs, hasDeleted, count } = postingColumns(list)
  for (let pi = 0; pi < count; pi++) {
    const internalId = docIds[pi]
    if (hasDeleted && deletedDocs.has(internalId)) continue
    if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
    if (fields && !fields.includes(fieldNames[fieldNameIndices[pi]])) continue
    bitsetSet(matched, internalId)
  }
}

export function searchFulltextMatches(state: PartitionReadState, params: InternalSearchParams): PartitionSearchMatches {
  const { queryTokens, prefixExpansion, fields, tolerance = 0, prefixLength = 2, exact = false, filterBitset } = params

  const fieldNames = state.fieldNameTable.names
  const matched = createBitSet(state.docStore.internalIdCapacity())

  for (const qt of queryTokens) {
    if (prefixExpansion && qt.token === prefixExpansion.token) {
      const seen = new Set<string>()
      for (const term of [qt.token, ...prefixExpansion.terms]) {
        if (seen.has(term)) continue
        seen.add(term)
        const postingList = state.invertedIdx.lookup(term)
        if (postingList) markPostingList(matched, postingList, fieldNames, fields, filterBitset)
      }
      continue
    }

    if (exact || tolerance === 0) {
      const postingList = state.invertedIdx.lookup(qt.token)
      if (postingList) markPostingList(matched, postingList, fieldNames, fields, filterBitset)
      continue
    }

    for (const match of state.invertedIdx.fuzzyLookup(qt.token, tolerance, prefixLength)) {
      markPostingList(matched, match.postingList, fieldNames, fields, filterBitset)
    }
  }

  const docStore = state.docStore
  const resolver = docStore.resolver()

  let count = 0
  for (let wordIndex = 0; wordIndex < matched.length; wordIndex++) {
    let word = matched[wordIndex]
    if (word === 0) continue
    const base = wordIndex << 5
    while (word !== 0) {
      const trailingZeros = Math.clz32(word & -word) ^ 31
      if (resolver.toExternal(base + trailingZeros) !== undefined) count++
      word &= word - 1
    }
  }

  return {
    count,
    hasExternal(docId: string): boolean {
      const internalId = docStore.getInternalId(docId)
      return internalId !== undefined && bitsetHas(matched, internalId)
    },
    hasInternal(internalId: number): boolean {
      return bitsetHas(matched, internalId)
    },
    matchedDocIds(): Set<string> {
      const external = new Set<string>()
      for (let wordIndex = 0; wordIndex < matched.length; wordIndex++) {
        let word = matched[wordIndex]
        if (word === 0) continue
        const base = wordIndex << 5
        while (word !== 0) {
          const trailingZeros = Math.clz32(word & -word) ^ 31
          const externalId = resolver.toExternal(base + trailingZeros)
          if (externalId !== undefined) external.add(externalId)
          word &= word - 1
        }
      }
      return external
    },
    ordinalBitset(): Uint32Array {
      return matched
    },
  }
}
