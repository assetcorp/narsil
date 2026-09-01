import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { DurableDirectory } from './durable-filesystem'
import { countLiveDocuments, legacySnapshotKey, readSegmentContents, readSegmentManifest } from './segment'
import type { SegmentContents } from './segment/segment-file'
import { decodeSnapshotBundle } from './snapshot-bundle'

/**
 * Counts the live documents in an index's last completed checkpoint, reading
 * the segment manifest when one exists and falling back to the legacy
 * snapshot bundle. An index with neither holds no checkpointed documents, so
 * the count is zero. A read or decode failure propagates, because a count the
 * store cannot back must stay unknown.
 *
 * @param directory - The durable store holding the index's files.
 * @param indexName - The index whose checkpoint is counted.
 * @returns The number of documents the last checkpoint holds.
 */
export async function countCheckpointDocuments(directory: DurableDirectory, indexName: string): Promise<number> {
  const manifest = await readSegmentManifest(directory, indexName)
  if (manifest !== null) {
    let total = 0
    for (const partition of manifest.partitions) {
      const ordered: SegmentContents[] = []
      for (const segment of partition.segments) {
        ordered.push(await readSegmentContents(directory, segment.key))
      }
      total += countLiveDocuments(ordered)
    }
    return total
  }
  const bytes = await directory.read(legacySnapshotKey(indexName))
  if (bytes === null) {
    return 0
  }
  return countSnapshotBundleDocuments(bytes)
}

/**
 * Counts the documents a snapshot bundle holds across all of its partitions.
 * A decode failure propagates.
 *
 * @param bytes - The encoded snapshot bundle.
 * @returns The number of documents in the bundle.
 */
export async function countSnapshotBundleDocuments(bytes: Uint8Array): Promise<number> {
  const bundle = await decodeSnapshotBundle(bytes)
  let total = 0
  for (const partitionBytes of bundle.partitions) {
    total += Object.keys(deserializePayloadV2(partitionBytes).documents).length
  }
  return total
}
