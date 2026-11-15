export interface MetadataWriteQueue {
  queue(indexName: string, write: () => Promise<void>): Promise<void>
  pending(indexName: string): Promise<void> | undefined
  forget(indexName: string): void
  settleAll(): Promise<void>
}

export function createMetadataWriteQueue(): MetadataWriteQueue {
  const writes = new Map<string, Promise<void>>()
  return {
    queue(indexName, write) {
      const previous = writes.get(indexName) ?? Promise.resolve()
      const queued = previous.then(write)
      writes.set(
        indexName,
        queued.catch(() => undefined),
      )
      return queued
    },
    pending: indexName => writes.get(indexName),
    forget(indexName) {
      writes.delete(indexName)
    },
    async settleAll() {
      let waiting = [...writes.values()]
      while (waiting.length > 0) {
        await Promise.all(waiting)
        const settled = waiting
        waiting = [...writes.values()].filter(write => !settled.includes(write))
      }
    },
  }
}
