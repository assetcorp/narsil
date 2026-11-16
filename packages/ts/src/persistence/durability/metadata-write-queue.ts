import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { DurableDirectory } from './durable-filesystem'

export async function writeIndexMetadataFile(
  directory: DurableDirectory,
  indexName: string,
  bytes: Uint8Array | readonly Uint8Array[],
): Promise<void> {
  try {
    await directory.atomicWrite(`${indexName}/meta`, bytes)
  } catch (error) {
    if (error instanceof NarsilError) throw error
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The engine cannot write the metadata of index "${indexName}" to the durability directory "${directory.root}"`,
      { indexName, directory: directory.root, cause: error instanceof Error ? error.message : String(error) },
    )
  }
}

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
