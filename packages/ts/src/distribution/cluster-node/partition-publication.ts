import type { EngineCore } from '../../engine/core'
import { updateDocumentVectors } from '../../engine/vector-coordinator'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { createDetachedIndex } from '../../workers/detached-index'
import { type ClusterWriteRecords, createClusterWriteRecords } from './write-records/keeper'

export async function publishPartitionCopy(
  core: EngineCore,
  indexName: string,
  partitionId: number,
  records: ClusterWriteRecords,
  load: (manager: PartitionManager, records: ClusterWriteRecords) => Promise<void>,
): Promise<void> {
  const current = core.requireManager(indexName)
  const analysis = current.analysis
  const earlier = current.getPartition(partitionId)
  const detached = createDetachedIndex(indexName, current.config, current.language, current.synonyms, core.executor)
  const staged = detached.manager
  const stagedRecords = createClusterWriteRecords()
  try {
    await load(staged, stagedRecords)
    await current.publication.write(() => {
      if (
        core.requireManager(indexName) !== current ||
        current.analysis !== analysis ||
        current.partitionAt(partitionId) !== earlier
      ) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_LOAD_FAILED,
          `Index "${indexName}" changed while its partition copy loaded`,
        )
      }
      const replacement = staged.getPartition(partitionId)
      const vectors = current.getVectorIndexes()
      const ids = vectors.size === 0 ? [] : new Set([...earlier.docIds(), ...replacement.docIds()])
      const previous = new Map<string, Map<string, Float32Array | null>>()
      for (const docId of ids) {
        previous.set(docId, new Map([...vectors].map(([field, vector]) => [field, vector.getVector(docId)])))
      }
      const changed: string[] = []
      try {
        for (const docId of ids) {
          const next = new Map(
            [...vectors.keys()].map(field => [field, staged.getVectorIndexes().get(field)?.getVector(docId) ?? null]),
          )
          updateDocumentVectors(docId, next, vectors, partitionId)
          changed.push(docId)
        }
      } catch (error) {
        for (const docId of changed) {
          const old = previous.get(docId)
          if (old !== undefined) updateDocumentVectors(docId, old, vectors, partitionId)
        }
        throw error
      }
      const partitions = current.getAllPartitions()
      partitions[partitionId] = replacement
      current.setPartitions(partitions)
      records.adoptPartition(indexName, partitionId, stagedRecords.partition(indexName, partitionId))
      staged.removePartition(partitionId)
    })
    for (const vector of current.getVectorIndexes().values()) vector.scheduleBuild()
  } finally {
    await core.executor.discardDetachedIndex(detached)
  }
}
