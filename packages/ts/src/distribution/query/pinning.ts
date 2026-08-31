import type { ScoredEntry, WirePinnedEntry } from '../transport/types'

/**
 * Places pinned documents into the merged, depth-truncated result list, the
 * way the local engine places them into its full ranking. The coordinator
 * calls this after the merge and before the offset slice, so positions count
 * from the top of the whole result set. An entry whose position falls beyond
 * a full window is unreachable on this page and is left out, and a pinned
 * document the query also matched moves to its pinned position.
 *
 * @param merged - The merged entries, truncated to the paging depth.
 * @param pinned - The pinned documents with their zero-based positions.
 * @param depth - The paging depth the merge truncated to, which is the limit plus the offset.
 * @returns The entries with every reachable pinned document placed.
 */
export function placePinnedEntries(merged: ScoredEntry[], pinned: WirePinnedEntry[], depth: number): ScoredEntry[] {
  const windowFull = merged.length >= depth
  const pinnedIds = new Set(pinned.map(entry => entry.docId))
  const removed = new Map<string, ScoredEntry>()
  const result: ScoredEntry[] = []
  for (const entry of merged) {
    if (pinnedIds.has(entry.docId)) {
      removed.set(entry.docId, entry)
    } else {
      result.push(entry)
    }
  }

  const ordered = pinned.slice().sort((a, b) => a.position - b.position)
  for (const entry of ordered) {
    if (windowFull && entry.position >= depth) continue
    const organic = removed.get(entry.docId)
    const placed: ScoredEntry = { docId: entry.docId, score: 0, sortValues: organic?.sortValues ?? null }
    result.splice(Math.max(0, Math.min(entry.position, result.length)), 0, placed)
  }
  return result
}
