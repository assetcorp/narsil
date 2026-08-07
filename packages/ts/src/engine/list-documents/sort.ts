import {
  type ComparableSortValue,
  compareCodePoints,
  compareSortValues,
  type SortDirection,
  toComparableSortValue,
} from '../../core/ordering'
import { readFieldValue } from '../../search/sorting'
import type { AnyDocument } from '../../types/schema'

export interface SortedDocument {
  id: string
  key: ComparableSortValue[]
}

export interface SortSelection {
  page: SortedDocument[]
  matching: number
}

function readSortKey(document: AnyDocument | undefined, fields: readonly string[]): ComparableSortValue[] {
  const key: ComparableSortValue[] = new Array(fields.length)
  for (let i = 0; i < fields.length; i++) {
    key[i] = document === undefined ? null : toComparableSortValue(readFieldValue(document, fields[i]))
  }
  return key
}

function insertOrdered(page: SortedDocument[], entry: SortedDocument, directions: readonly SortDirection[]): void {
  let low = 0
  let high = page.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const candidate = page[mid]
    const comparison =
      compareSortValues(candidate.key, entry.key, directions) || compareCodePoints(candidate.id, entry.id)
    if (comparison <= 0) low = mid + 1
    else high = mid
  }
  page.splice(low, 0, entry)
}

/**
 * Walks every candidate once and keeps the `limit` documents that sort first
 * after the cursor anchor.
 *
 * Holding only the page bounds memory by the page size rather than by the index
 * size, and comparing each candidate against the current worst entry keeps most
 * candidates to a single comparison.
 */
export function selectSortedPage(
  candidates: readonly string[],
  sort: Record<string, SortDirection>,
  getDocument: (docId: string) => AnyDocument | undefined,
  limit: number,
  anchorKey: readonly ComparableSortValue[] | null,
  anchorId: string | null,
): SortSelection {
  const fields = Object.keys(sort)
  const directions = fields.map(field => sort[field])

  const page: SortedDocument[] = []
  let matching = 0

  for (const id of candidates) {
    const key = readSortKey(getDocument(id), fields)

    if (anchorKey !== null && anchorId !== null) {
      const versusAnchor = compareSortValues(key, anchorKey, directions) || compareCodePoints(id, anchorId)
      if (versusAnchor <= 0) continue
    }

    matching++

    if (page.length === limit) {
      const worst = page[limit - 1]
      const versusWorst = compareSortValues(key, worst.key, directions) || compareCodePoints(id, worst.id)
      if (versusWorst >= 0) continue
      page.pop()
    }

    insertOrdered(page, { id, key }, directions)
  }

  return { page, matching }
}
