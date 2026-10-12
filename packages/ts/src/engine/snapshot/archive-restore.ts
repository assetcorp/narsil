import { ErrorCodes, NarsilError } from '../../errors'
import type { ByteReader } from '../../persistence/archive/byte-reader'
import { memoryCheckpointStore } from '../../persistence/archive/memory-store'
import { readSnapshotArchive } from '../../persistence/archive/read'
import { validateStagedCheckpoint } from '../../persistence/archive/validate'
import type { RestoreStaging } from '../../persistence/durability/archive-checkpoint'
import { manifestKey } from '../../persistence/durability/segment/layout'
import { loadSegmentedCheckpoint } from '../../persistence/durability/segment/load'
import { encodeSegmentManifest, type SegmentManifest } from '../../persistence/durability/segment/manifest'
import type { CheckpointStore } from '../../persistence/durability/segment/store'
import { flattenSchema } from '../../schema/validator'
import { decodeIndexConfiguration } from './index-configuration'
import {
  abandonRestoredIndex,
  type CreatedIndex,
  createRestoredIndex,
  type PreparedIndex,
  prepareRestoredIndex,
  type RestoreDeps,
  recordRestoredCounts,
} from './restore-setup'

function rejectConfiguration(message: string): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Invalid index configuration: ${message}`)
}

function renamed(manifest: SegmentManifest, sourceName: string, indexName: string): SegmentManifest {
  const rename = (key: string): string => `${indexName}/${key.slice(sourceName.length + 1)}`
  return {
    ...manifest,
    partitions: manifest.partitions.map(partition => ({
      ...partition,
      segments: partition.segments.map(segment => ({ ...segment, key: rename(segment.key) })),
    })),
    vectors: manifest.vectors.map(field => ({
      ...field,
      files: field.files.map(file => ({ ...file, key: rename(file.key) })),
      graphParts: field.graphParts.map(part => ({ ...part, key: rename(part.key) })),
    })),
  }
}

function requireSameSchema(prepared: PreparedIndex, manifest: SegmentManifest): void {
  const configured = flattenSchema(prepared.config.schema) as Record<string, string>
  const keys = new Set([...Object.keys(configured), ...Object.keys(manifest.schema)])
  for (const field of keys) {
    if (configured[field] === manifest.schema[field]) continue
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The archive's configuration gives field "${field}" another type than its manifest does`,
      { field },
    )
  }
}

function partitionCountOf(manifest: SegmentManifest): number {
  let count = 1
  for (const partition of manifest.partitions) count = Math.max(count, partition.partitionId + 1)
  return count
}

interface StagedArchive {
  prepared: PreparedIndex | null
  manifest: SegmentManifest | null
}

function missingPart(what: string): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The archive holds no ${what}`)
}

async function stageArchive(indexName: string, reader: ByteReader, staging: CheckpointStore, deps: RestoreDeps) {
  const staged: StagedArchive = { prepared: null, manifest: null }
  await readSnapshotArchive(reader, {
    config: async bytes => {
      staged.prepared = prepareRestoredIndex(await decodeIndexConfiguration(bytes), deps, rejectConfiguration)
    },
    manifest: async (manifest, sourceName) => {
      if (staged.prepared === null) missingPart('configuration')
      requireSameSchema(staged.prepared, manifest)
      staged.manifest = renamed(manifest, sourceName, indexName)
    },
    file: async (entryName, _ref, bytes) => {
      if (staged.manifest === null) missingPart('manifest')
      await staging.write(`${indexName}/${entryName}`, [bytes])
    },
  })
  const { prepared, manifest } = staged
  if (prepared === null) missingPart('configuration')
  if (manifest === null) missingPart('manifest')
  await validateStagedCheckpoint(staging, manifest)
  return { prepared, manifest }
}

async function replaceWithStaged(
  indexName: string,
  staged: { prepared: PreparedIndex; manifest: SegmentManifest },
  staging: RestoreStaging | null,
  memory: CheckpointStore,
  deps: RestoreDeps,
): Promise<CreatedIndex> {
  const { prepared, manifest } = staged
  const durable = deps.durability?.manager
  const created = await createRestoredIndex(indexName, prepared, partitionCountOf(manifest), deps)
  try {
    if (staging !== null && durable !== undefined) await durable.persistMetadata(indexName)
    const store = staging === null ? memory : await staging.commit()
    await store.write(manifestKey(indexName), (await encodeSegmentManifest(manifest)).chunks)
    await loadSegmentedCheckpoint(
      store,
      indexName,
      manifest,
      { manager: created.manager, vectorIndexes: created.manager.getVectorIndexes() },
      true,
    )
    recordRestoredCounts(indexName, created.manager, deps)
    if (durable?.adoptRestoredCheckpoint !== undefined && staging !== null) {
      durable.adoptRestoredCheckpoint(indexName, manifest.checkpoint)
      await durable.persistMetadata(indexName)
    } else if (durable !== undefined) {
      await durable.persistMetadata(indexName)
      await durable.checkpoint(indexName)
    }
    await deps.announceIndexCreated(indexName, prepared.config)
    return created
  } catch (error) {
    created.release()
    await abandonRestoredIndex(indexName, deps)
    throw error
  }
}

export async function restoreArchive(indexName: string, reader: ByteReader, deps: RestoreDeps): Promise<void> {
  const staging = deps.durability?.manager.stageRestore?.(indexName) ?? null
  const memory = memoryCheckpointStore()
  try {
    const staged = await stageArchive(indexName, reader, staging?.store ?? memory, deps)
    const created = await replaceWithStaged(indexName, staged, staging, memory, deps)
    created.release()
  } finally {
    await staging?.discard().catch(() => undefined)
    await reader.close()
  }
}
