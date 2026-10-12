import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readSegmentManifest } from '../../../persistence/durability/segment/load'
import type { SegmentManifest } from '../../../persistence/durability/segment/manifest'
import { directoryCheckpointStore } from '../../../persistence/durability/segment/store'

export async function manifestOnDisk(
  directory: DurableDirectory | string,
  indexName: string,
): Promise<SegmentManifest | null> {
  const durable = typeof directory === 'string' ? createDurableDirectory(directory) : directory
  const decoded = await readSegmentManifest(directoryCheckpointStore(durable), indexName)
  if (decoded === null) return null
  if (decoded.kind !== 'current') throw new Error(`index ${indexName} still holds the layout of an earlier release`)
  return decoded.manifest
}

export async function requireManifestOnDisk(
  directory: DurableDirectory | string,
  indexName: string,
): Promise<SegmentManifest> {
  const manifest = await manifestOnDisk(directory, indexName)
  if (manifest === null) throw new Error(`index ${indexName} holds no manifest`)
  return manifest
}
