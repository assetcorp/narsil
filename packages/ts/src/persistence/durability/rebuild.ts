import { reconstructSchemaFromMetadata } from '../../engine/recovery-schema'
import { getLanguage } from '../../languages/registry'
import { createPartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import type { IndexMetadata } from '../../types/internal'
import { createVectorIndex, type VectorIndex } from '../../vector/vector-index'
import { writeSnapshotFile } from './checkpoint'
import { createDurableDirectory } from './durable-filesystem'
import { loadSnapshot, type ReplayDeps, replayWalUpTo, snapshotCheckpointFor } from './recovery'
import type { PartitionCheckpoint } from './snapshot-bundle'

export async function rebuildSnapshotFromDurable(
  root: string,
  metadata: IndexMetadata,
  targets: PartitionCheckpoint[],
): Promise<void> {
  const directory = createDurableDirectory(root)
  const indexName = metadata.indexName
  const config = reconstructSchemaFromMetadata(metadata)
  const language = getLanguage(config.language ?? 'english')
  const router = createPartitionRouter()

  const vectorFields = extractVectorFieldsFromSchema(config.schema)
  const vectorIndexes = new Map<string, VectorIndex>()
  for (const [fieldPath, dimension] of vectorFields) {
    vectorIndexes.set(fieldPath, createVectorIndex(fieldPath, dimension, config.vectorPromotion))
  }

  const partitionCount = Math.max(1, targets.length)
  const manager = createPartitionManager(indexName, config, language, router, partitionCount, vectorIndexes)
  const deps: ReplayDeps = {
    manager,
    vectorFieldPaths: new Set(vectorFields.keys()),
    vectorIndexes,
  }

  const priorCheckpoint = await loadSnapshot(directory, indexName, deps)

  const seqNoByPartition = new Map<number, number>()
  const primaryTermByPartition = new Map<number, number>()
  for (const target of targets) {
    const fromSeqNoExclusive = snapshotCheckpointFor(priorCheckpoint, target.partitionId)
    await replayWalUpTo(directory, indexName, target.partitionId, fromSeqNoExclusive, target.lastSeqNo, deps)
    seqNoByPartition.set(target.partitionId, target.lastSeqNo)
    primaryTermByPartition.set(target.partitionId, target.primaryTerm)
  }

  await writeSnapshotFile(directory, {
    indexName,
    schema: metadata.schema,
    language: metadata.language,
    manager,
    vectorIndexes,
    seqNoByPartition,
    primaryTermByPartition,
  })
}
