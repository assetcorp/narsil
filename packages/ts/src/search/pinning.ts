import type { Hit } from '../types/results'
import { pinnedOrder } from './pinned-order'

/**
 * Drops every repeated docId from a pinned list, keeping each document's
 * first listed entry, so one document takes one position however the caller
 * repeats it. The engine and the cluster coordinator both place through this
 * rule, which is what keeps a repeated pin identical on the two paths.
 *
 * @param pinned - The pinned entries as the caller listed them.
 * @returns The entries with each docId's first occurrence kept, in list order.
 */
export function dedupePinnedEntries<T extends { docId: string }>(pinned: T[]): T[] {
  const deduped: T[] = []
  const seen = new Set<string>()
  for (const entry of pinned) {
    if (seen.has(entry.docId)) continue
    seen.add(entry.docId)
    deduped.push(entry)
  }
  return deduped
}

/**
 * Places pinned documents at their positions in a ranked hit list, which
 * serves sponsored and editorial placements. A pinned document the list
 * already holds moves to its position, a docId the resolver cannot produce is
 * skipped, a repeated docId places once at its first listed position, and a
 * position past the end clamps to the end.
 *
 * @param hits - The ranked hits to place into.
 * @param pinned - The documents to place, each with its zero-based position.
 * @param resolveDoc - Produces the hit for a pinned document, or undefined for one the store lacks.
 * @returns The hits with every resolvable pinned document placed, and how many of those the ranked list did not hold.
 */
export function placePinned<T>(
  hits: Array<Hit<T>>,
  pinned: Array<{ docId: string; position: number }>,
  resolveDoc: (docId: string) => Hit<T> | undefined,
): { hits: Array<Hit<T>>; placedFromOutside: number } {
  const entries: Array<{ docId: string; position: number }> = []
  const documents: Array<Hit<T>> = []
  for (const entry of dedupePinnedEntries(pinned)) {
    const document = resolveDoc(entry.docId)
    if (document === undefined) continue
    entries.push(entry)
    documents.push(document)
  }
  const { order, ranked } = pinnedOrder(
    hits.map(hit => hit.id),
    entries,
    null,
  )
  const result = new Array<Hit<T>>(order.length)
  let placedFromOutside = 0
  for (let at = 0; at < order.length; at++) {
    const source = order[at]
    result[at] = source < 0 ? documents[-1 - source] : hits[source]
    if (source < 0 && ranked[-1 - source] < 0) placedFromOutside++
  }
  return { hits: result, placedFromOutside }
}
