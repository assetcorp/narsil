import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { DurableDirectory } from './durable-filesystem'
import { countLiveDocuments, legacySnapshotKey, readSegmentContents, readSegmentManifest } from './segment'
import type { SegmentContents } from './segment/segment-file'
import { decodeSnapshotBundle } from './snapshot-bundle'

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

export async function countSnapshotBundleDocuments(bytes: Uint8Array): Promise<number> {
  const bundle = await decodeSnapshotBundle(bytes)
  let total = 0
  for (const partitionBytes of bundle.partitions) {
    total += Object.keys(deserializePayloadV2(partitionBytes).documents).length
  }
  return total
}
