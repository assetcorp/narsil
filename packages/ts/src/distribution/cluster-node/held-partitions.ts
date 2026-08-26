import type { EngineCore } from '../../engine/core'

/**
 * Records that this node's copy of an index holds a partition, and persists the record beside the index identity.
 *
 * The controller asks a returning node which partitions its copy holds before it gives an unserved partition back,
 * and a document count answers that question wrongly for a partition holding nothing. This record answers it from
 * what the node was given, so an empty partition survives the loss of every copy the same way a full one does.
 *
 * @param core - The engine core holding the index registry and the durability manager.
 * @param indexName - The index the partition belongs to.
 * @param partitionId - The partition this node now holds.
 * @returns A promise that settles once the record is durable.
 */
export async function recordHeldPartition(core: EngineCore, indexName: string, partitionId: number): Promise<void> {
  await writeHeldPartitions(core, indexName, held => (held.includes(partitionId) ? null : [...held, partitionId]))
}

/**
 * Removes a partition from the record of what this node's copy holds, so the controller stops counting it as a
 * holder.
 *
 * @param core - The engine core holding the index registry and the durability manager.
 * @param indexName - The index the partition belongs to.
 * @param partitionId - The partition this node has given up.
 * @returns A promise that settles once the record is durable.
 */
export async function forgetHeldPartition(core: EngineCore, indexName: string, partitionId: number): Promise<void> {
  await writeHeldPartitions(core, indexName, held =>
    held.includes(partitionId) ? held.filter(id => id !== partitionId) : null,
  )
}

/**
 * Reports which partitions this node's copy of an index holds, and reports `undefined` where nothing recorded them.
 *
 * An index written before this record existed reports `undefined`, which tells a caller to fall back to the
 * partitions holding a document.
 *
 * @param core - The engine core holding the index registry.
 * @param indexName - The index to report on.
 * @returns The partitions in ascending order, or `undefined` where the copy carries no record.
 */
export function heldPartitionsOf(core: EngineCore, indexName: string): number[] | undefined {
  return core.indexRegistry.get(indexName)?.heldPartitions ?? undefined
}

async function writeHeldPartitions(
  core: EngineCore,
  indexName: string,
  next: (held: number[]) => number[] | null,
): Promise<void> {
  const entry = core.indexRegistry.get(indexName)
  if (entry === undefined) {
    return
  }
  const updated = next(entry.heldPartitions ?? [])
  if (updated === null) {
    return
  }
  core.indexRegistry.set(indexName, { ...entry, heldPartitions: [...updated].sort((a, b) => a - b) })
  if (core.durability !== null) {
    await core.durability.manager.persistMetadata(indexName)
  }
}
