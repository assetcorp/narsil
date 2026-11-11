import { oneSyncChangeAtATime } from '#platform/storage-host'
import type { ArchiveCheckpoint } from '../../persistence/durability/archive-checkpoint'
import type { EngineCore } from '../core'
import { documentExportStream, type ExportPositions } from '../export/write'
import { checkpointForArchive, type SnapshotDeps } from '../snapshot'
import { indexConfigurationOf } from '../snapshot/index-configuration-encode'

function positionsOf(epoch: string, partitionCount: number, checkpoint: ArchiveCheckpoint): ExportPositions {
  const positions: ExportPositions['positions'] = []
  for (let partitionId = 0; partitionId < partitionCount; partitionId++) {
    const held = checkpoint.manifest.checkpoint.find(entry => entry.partitionId === partitionId)
    positions.push({ partitionId, seqNo: held?.lastSeqNo ?? 0 })
  }
  return { epoch, positions }
}

export async function openDocumentExport(
  core: Pick<EngineCore, 'indexRegistry' | 'requireIndex'>,
  deps: SnapshotDeps,
): Promise<ReadableStream<Uint8Array>> {
  const { indexName } = deps
  if (core.requireIndex(indexName).changes === null) {
    const header = indexConfigurationOf(core.requireIndex(indexName))
    return documentExportStream(header, await checkpointForArchive(deps))
  }
  return oneSyncChangeAtATime(core.indexRegistry, indexName, async () => {
    const entry = core.requireIndex(indexName)
    const header = indexConfigurationOf(entry)
    const checkpoint = await checkpointForArchive({ ...deps, entry })
    if (entry.changes === null) return documentExportStream(header, checkpoint)
    return documentExportStream(header, checkpoint, positionsOf(entry.changes.epoch, entry.partitionCount, checkpoint))
  })
}
