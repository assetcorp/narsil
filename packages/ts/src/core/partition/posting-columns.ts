import type { PostingListView } from '../../types/internal'

export interface PostingColumns {
  docIds: ArrayLike<number>
  termFrequencies: ArrayLike<number>
  fieldNameIndices: ArrayLike<number>
  deletedDocs: PostingListView['deletedDocs']
  hasDeleted: boolean
  count: number
}

/**
 * Reads the columns of a posting list into locals once, so that a scoring
 * loop indexes typed arrays directly in place of reading them back through
 * the view on every posting.
 *
 * @param list - The posting list a loop is about to walk.
 * @returns The three columns, the deleted set and whether it holds anything,
 * and the posting count.
 */
export function postingColumns(list: PostingListView): PostingColumns {
  const deletedDocs = list.deletedDocs
  return {
    docIds: list.docIds,
    termFrequencies: list.termFrequencies,
    fieldNameIndices: list.fieldNameIndices,
    deletedDocs,
    hasDeleted: deletedDocs.size > 0,
    count: list.length,
  }
}
