import type { Hit } from '../types/results'

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
 * @returns The hits with every resolvable pinned document placed.
 */
export function applyPinning<T>(
  hits: Array<Hit<T>>,
  pinned: Array<{ docId: string; position: number }>,
  resolveDoc: (docId: string) => Hit<T> | undefined,
): Array<Hit<T>> {
  const result = hits.slice()

  const deduped = dedupePinnedEntries(pinned)
  const pinnedDocIds = new Set(deduped.map(entry => entry.docId))
  for (let i = result.length - 1; i >= 0; i--) {
    if (pinnedDocIds.has(result[i].id)) {
      result.splice(i, 1)
    }
  }

  const sorted = deduped.sort((a, b) => a.position - b.position)

  for (const entry of sorted) {
    const doc = resolveDoc(entry.docId)
    if (!doc) continue

    const pos = Math.max(0, Math.min(entry.position, result.length))
    result.splice(pos, 0, doc)
  }

  return result
}
