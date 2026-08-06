import { compareSortValues, readFieldValue, type SortDirection } from '../../search/sorting'
import type { AnyDocument } from '../../types/schema'
import type { SortKeyValue } from './cursor'
import { toSortKey } from './cursor'

export interface SortedDocument {
  id: string
  key: SortKeyValue[]
}

export interface SortSelection {
  page: SortedDocument[]
  matching: number
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function readSortKey(document: AnyDocument | undefined, fields: readonly string[]): SortKeyValue[] {
  const key: SortKeyValue[] = new Array(fields.length)
  for (let i = 0; i < fields.length; i++) {
    key[i] = document === undefined ? null : toSortKey(readFieldValue(document, fields[i]))
  }
  return key
}

function insertOrdered(
  page: SortedDocument[],
  entry: SortedDocument,
  directions: readonly SortDirection[],
  collator: Intl.Collator,
): void {
  let low = 0
  let high = page.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const candidate = page[mid]
    const comparison =
      compareSortValues(candidate.key, entry.key, directions, collator) || compareIds(candidate.id, entry.id)
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
  anchorKey: SortKeyValue[] | null,
  anchorId: string | null,
): SortSelection {
  const fields = Object.keys(sort)
  const directions = fields.map(field => sort[field])
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' })

  const page: SortedDocument[] = []
  let matching = 0

  for (const id of candidates) {
    const key = readSortKey(getDocument(id), fields)

    if (anchorKey !== null && anchorId !== null) {
      const versusAnchor = compareSortValues(key, anchorKey, directions, collator) || compareIds(id, anchorId)
      if (versusAnchor <= 0) continue
    }

    matching++

    if (page.length === limit) {
      const worst = page[limit - 1]
      const versusWorst = compareSortValues(key, worst.key, directions, collator) || compareIds(id, worst.id)
      if (versusWorst >= 0) continue
      page.pop()
    }

    insertOrdered(page, { id, key }, directions, collator)
  }

  return { page, matching }
}
