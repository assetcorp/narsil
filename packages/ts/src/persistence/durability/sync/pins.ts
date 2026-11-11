export interface FilePins {
  pin(keys: Iterable<string>): () => void
  isPinned(key: string): boolean
  removeWhenUnpinned(key: string): boolean
}

export function createFilePins(remove: (key: string) => Promise<void>): FilePins {
  const counts = new Map<string, number>()
  const awaitingRemoval = new Set<string>()

  function unpin(key: string): void {
    const count = (counts.get(key) ?? 1) - 1
    if (count > 0) {
      counts.set(key, count)
      return
    }
    counts.delete(key)
    if (!awaitingRemoval.delete(key)) return
    void remove(key).catch(() => undefined)
  }

  return {
    pin(keys) {
      const pinned = [...keys]
      for (const key of pinned) counts.set(key, (counts.get(key) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        for (const key of pinned) unpin(key)
      }
    },
    isPinned: key => counts.has(key),
    removeWhenUnpinned(key) {
      if (!counts.has(key)) return false
      awaitingRemoval.add(key)
      return true
    },
  }
}
