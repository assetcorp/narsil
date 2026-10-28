import type { InternalSearchParams, PostingListView } from '../../types/internal'
import { bitsetHas, bitsetSet, createBitSet } from '../bitset'
import type { PartitionFilterMatches } from './filters'
import { partialFieldMarks, termGroupOf, typoMatchesFor } from './group-scoring'
import { postingColumns } from './posting-columns'
import type { PartitionReadState } from './utils'

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
  markedFields: Uint8Array,
  filterBitset: Uint32Array | undefined,
): void {
  const { docIds, fieldNameIndices, deletedDocs, hasDeleted, count } = postingColumns(list)
  for (let pi = 0; pi < count; pi++) {
    const internalId = docIds[pi]
    if (hasDeleted && deletedDocs.has(internalId)) continue
    if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
    if (markedFields[fieldNameIndices[pi]] === 0) continue
    bitsetSet(matched, internalId)
  }
}

function searchedFieldMarks(fieldNames: readonly string[], fields: readonly string[] | undefined): Uint8Array {
  const marks = new Uint8Array(fieldNames.length)
  for (let fieldIndex = 0; fieldIndex < fieldNames.length; fieldIndex++) {
    if (fields === undefined || fields.includes(fieldNames[fieldIndex])) marks[fieldIndex] = 1
  }
  return marks
}

export function searchFulltextMatches(state: PartitionReadState, params: InternalSearchParams): PartitionSearchMatches {
  const { queryTokens, termGroups, fields, tolerance = 0, prefixLength = 2, exact = false, filterBitset } = params

  const fieldNames = state.fieldNameTable.names
  const matched = createBitSet(state.docStore.internalIdCapacity())
  const searched = searchedFieldMarks(fieldNames, fields)
  const partial = partialFieldMarks(fieldNames, params.partialFields)
  const searchedPartial = searched.map((mark, fieldIndex) => mark & partial[fieldIndex])

  for (const qt of queryTokens) {
    const group = termGroupOf(termGroups, qt.token)
    for (const match of typoMatchesFor(state.invertedIdx, qt.token, group, exact, tolerance, prefixLength)) {
      markPostingList(matched, match.postingList, searched, filterBitset)
    }
    if (group === undefined) continue
    for (const member of group.members) {
      const postingList = state.invertedIdx.lookup(member.token)
      if (postingList === undefined) continue
      markPostingList(matched, postingList, member.factor > 0 ? searched : searchedPartial, filterBitset)
    }
    if (group.synonyms !== undefined) {
      for (const synonym of group.synonyms.tokens) {
        const postingList = state.invertedIdx.lookup(synonym)
        if (postingList !== undefined) markPostingList(matched, postingList, searched, filterBitset)
      }
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
      if (resolver.isLive(base + trailingZeros)) count++
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
