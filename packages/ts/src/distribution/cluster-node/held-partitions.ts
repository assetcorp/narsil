import type { EngineCore } from '../../engine/core'

/**
 * The record of which partitions this node's copy of each index holds, which a cluster node answers a
 * partition-stores request from.
 *
 * @public
 */
export interface HeldPartitionRecord {
  record(indexName: string, partitionId: number): Promise<void>
  forget(indexName: string, partitionId: number): Promise<void>
  held(indexName: string): number[] | undefined
}

/**
 * Builds the record of which partitions this node's copy of each index holds.
 *
 * The controller asks a returning node which partitions its copy holds before it gives an unserved partition back,
 * and a document count answers that question wrongly for a partition holding nothing. This record answers it from
 * what the node was given, so an empty partition survives the loss of every copy the same way a full one does.
 *
 * Each index takes its writes in turn, because two writes persisting at once would let an older list win the rename
 * and leave the node claiming a partition it has given up. A write whose persist fails keeps the list in memory and
 * raises the failure, so the node answers for the partition while it stays up, and it marks the index for another
 * write, so the next call persists the list again even where the list has not changed.
 *
 * @param core - The engine core holding the index registry and the durability manager.
 * @returns The record, which reads and writes the index metadata this node persists.
 */
export function createHeldPartitionRecord(core: EngineCore): HeldPartitionRecord {
  const writesByIndex = new Map<string, Promise<void>>()
  const indexesBehindOnDisk = new Set<string>()

  function queueWrite(indexName: string, next: (held: number[]) => number[] | null): Promise<void> {
    const previous = writesByIndex.get(indexName) ?? Promise.resolve()
    const write = previous.then(() => writeHeldPartitions(core, indexName, next, indexesBehindOnDisk))
    writesByIndex.set(
      indexName,
      write.catch(() => undefined),
    )
    return write
  }

  return {
    record(indexName: string, partitionId: number): Promise<void> {
      return queueWrite(indexName, held => (held.includes(partitionId) ? null : [...held, partitionId]))
    },

    forget(indexName: string, partitionId: number): Promise<void> {
      return queueWrite(indexName, held => (held.includes(partitionId) ? held.filter(id => id !== partitionId) : null))
    },

    held(indexName: string): number[] | undefined {
      return core.indexRegistry.get(indexName)?.heldPartitions ?? undefined
    },
  }
}

async function writeHeldPartitions(
  core: EngineCore,
  indexName: string,
  next: (held: number[]) => number[] | null,
  indexesBehindOnDisk: Set<string>,
): Promise<void> {
  const entry = core.indexRegistry.get(indexName)
  if (entry === undefined) {
    return
  }
  const updated = next(entry.heldPartitions ?? [])
  if (updated === null && !indexesBehindOnDisk.has(indexName)) {
    return
  }
  if (updated !== null) {
    core.indexRegistry.set(indexName, { ...entry, heldPartitions: [...updated].sort((a, b) => a - b) })
  }
  if (core.durability === null) {
    return
  }
  indexesBehindOnDisk.add(indexName)
  await core.durability.manager.persistMetadata(indexName)
  indexesBehindOnDisk.delete(indexName)
}
