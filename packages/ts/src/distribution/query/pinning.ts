import { requireLoadedOptionalReads } from '../../engine/optional-reads-code'
import type { ScoredEntry, WirePinnedEntry } from '../transport/types'

/**
 * Picks the entry a page cursor anchors on: the last entry of the page that is
 * not a pinned placement, because a placement carries no real score or sort
 * key to seek from. A page holding only placements yields no anchor, which
 * ends cursor paging for that request.
 *
 * @param page - The entries the page returns, in order.
 * @param pinned - The pinned documents placed on this page, or null when none were placed.
 * @returns The anchor entry, or undefined when every entry is a placement.
 */
export function lastOrganicEntry(page: ScoredEntry[], pinned: WirePinnedEntry[] | null): ScoredEntry | undefined {
  if (pinned === null) {
    return page.length > 0 ? page[page.length - 1] : undefined
  }
  const pinnedIds = new Set(pinned.map(entry => entry.docId))
  for (let i = page.length - 1; i >= 0; i--) {
    if (!pinnedIds.has(page[i].docId)) return page[i]
  }
  return undefined
}

/**
 * Places pinned documents into the merged, depth-truncated result list, the
 * way the local engine places them into its full ranking. The coordinator
 * calls this after the merge and before the offset slice, so positions count
 * from the top of the whole result set. A pinned document the query also
 * matched moves to its pinned position, a repeated docId places once at its
 * first listed position, and a position past the end clamps to the end only
 * while the merge holds every match, because a short merge under partition
 * failures says nothing about where the end of the results is.
 *
 * @param merged - The merged entries, truncated to the paging depth.
 * @param pinned - The pinned documents with their zero-based positions.
 * @param depth - The paging depth the merge truncated to, which is the limit plus the offset.
 * @param allMatchesPresent - True when every partition answered and the merge holds every matching document.
 * @returns The entries with every reachable pinned document placed.
 */
export function placePinnedEntries(
  merged: ScoredEntry[],
  pinned: WirePinnedEntry[],
  depth: number,
  allMatchesPresent: boolean,
  stored?: ReadonlySet<string>,
): { entries: ScoredEntry[]; placedFromOutside: string[] } {
  const { dedupePinnedEntries, pinnedOrder } = requireLoadedOptionalReads()
  const deduped = dedupePinnedEntries(stored === undefined ? pinned : pinned.filter(entry => stored.has(entry.docId)))
  const { order, ranked } = pinnedOrder(
    merged.map(entry => entry.docId),
    deduped,
    allMatchesPresent ? null : depth,
  )
  const result = new Array<ScoredEntry>(order.length)
  const placedFromOutside: string[] = []
  for (let at = 0; at < order.length; at++) {
    const source = order[at]
    if (source >= 0) {
      result[at] = merged[source]
      continue
    }
    const pin = -1 - source
    const entry = deduped[pin]
    const organic = ranked[pin] < 0 ? undefined : merged[ranked[pin]]
    if (organic === undefined) placedFromOutside.push(entry.docId)
    result[at] = { docId: entry.docId, score: 0, sortValues: organic?.sortValues ?? null }
  }
  return { entries: result, placedFromOutside }
}
