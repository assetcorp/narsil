import type { Hit } from '../types/results'

export function applyPinning<T>(
  hits: Array<Hit<T>>,
  pinned: Array<{ docId: string; position: number }>,
  resolveDoc: (docId: string) => Hit<T> | undefined,
): Array<Hit<T>> {
  const result = hits.slice()

  const pinnedDocIds = new Set(pinned.map(p => p.docId))
  for (let i = result.length - 1; i >= 0; i--) {
    if (pinnedDocIds.has(result[i].id)) {
      result.splice(i, 1)
    }
  }

  const sorted = pinned.slice().sort((a, b) => a.position - b.position)

  for (const entry of sorted) {
    const doc = resolveDoc(entry.docId)
    if (!doc) continue

    const pos = Math.max(0, Math.min(entry.position, result.length))
    result.splice(pos, 0, doc)
  }

  return result
}
