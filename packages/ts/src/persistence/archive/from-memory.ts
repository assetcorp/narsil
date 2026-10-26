import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import type { IndexMetadata } from '../../types/internal'
import type { VectorCheckpointPlan, VectorIndex } from '../../vector/vector-index'
import { VECTOR_FILE_PAYLOAD_VERSION, type VectorFilePayload } from '../../vector/vector-index/checkpoint-payload'
import { type NewVectorFile, vectorsPerFile } from '../../vector/vector-index/checkpoint-plan'
import { vectorsToBytes } from '../../vector/vector-index/payload'
import type { ArchiveCheckpoint } from '../durability/archive-checkpoint'
import { DEFAULT_COMPACTION_THRESHOLD } from '../durability/constants'
import type { PartitionCheckpoint } from '../durability/partition-checkpoint'
import { partitionContentsOf } from '../durability/segment/captured-partition'
import { manifestKey } from '../durability/segment/layout'
import type { VectorFieldRef } from '../durability/segment/manifest'
import { decodeSegmentManifest } from '../durability/segment/manifest-decode'
import { writeLiveVectors } from '../durability/segment/vector-write'
import { commitCheckpointManifest, writeCheckpointSegments } from '../durability/segment/write'
import { SINGLE_NODE_PRIMARY_TERM } from '../durability/seq-owner'
import { memoryCheckpointStore } from './memory-store'

export interface MemoryArchiveInput {
  indexName: string
  metadata: IndexMetadata
  manager: PartitionManager
  vectorIndexes: Map<string, VectorIndex>
  appliedSeqNo(partitionId: number): number
  partitionId: number | null
}

function frozenPlan(plan: VectorCheckpointPlan): VectorCheckpointPlan {
  const files: NewVectorFile[] = []
  for (let index = 0; index < plan.newFiles; index++) files.push(plan.readNewFile(index))
  return { ...plan, readNewFile: index => files[index] }
}

function partitionVectorPlan(vectorIndex: VectorIndex, docIds: readonly string[]): VectorCheckpointPlan {
  const held: string[] = []
  const vectors: Float32Array[] = []
  for (const docId of docIds) {
    const vector = vectorIndex.getVector(docId)
    if (vector === null) continue
    held.push(docId)
    vectors.push(Float32Array.from(vector))
  }
  const capacity = vectorsPerFile(vectorIndex.dimension, null)
  const files: NewVectorFile[] = []
  for (let start = 0; start < held.length; start += capacity) {
    const slice = held.slice(start, start + capacity)
    const packed = new Float32Array(slice.length * vectorIndex.dimension)
    for (let i = 0; i < slice.length; i++) packed.set(vectors[start + i], i * vectorIndex.dimension)
    const payload: VectorFilePayload = {
      v: VECTOR_FILE_PAYLOAD_VERSION,
      fieldName: vectorIndex.fieldName,
      dimension: vectorIndex.dimension,
      docIds: slice,
      codes: null,
      vectors: vectorsToBytes(packed),
    }
    files.push({ payload, ordinals: new Int32Array(slice.length), dead: null })
  }
  return {
    unchanged: false,
    kept: [],
    keptFiles: [],
    newFiles: files.length,
    graphParts: null,
    signature: { revision: 0, graphSize: -1, calibration: null },
    readNewFile: index => files[index],
  }
}

interface CapturedArchive {
  targets: PartitionCheckpoint[]
  contents: ReturnType<typeof partitionContentsOf>[]
  plans: Map<string, VectorCheckpointPlan>
}

function capture(input: MemoryArchiveInput): CapturedArchive {
  const partitionIds =
    input.partitionId === null
      ? Array.from({ length: input.manager.partitionCount }, (_, partitionId) => partitionId)
      : [input.partitionId]
  const targets: PartitionCheckpoint[] = partitionIds.map(partitionId => ({
    partitionId,
    lastSeqNo: input.appliedSeqNo(partitionId),
    primaryTerm: SINGLE_NODE_PRIMARY_TERM,
  }))
  const contents = partitionIds.map(partitionId => partitionContentsOf(input.manager, partitionId))
  const plans = new Map<string, VectorCheckpointPlan>()
  const partitionDocIds =
    input.partitionId === null ? null : [...input.manager.getPartition(input.partitionId).docIds()]
  for (const [fieldPath, vectorIndex] of input.vectorIndexes) {
    plans.set(
      fieldPath,
      partitionDocIds === null
        ? frozenPlan(vectorIndex.planCheckpoint(null))
        : partitionVectorPlan(vectorIndex, partitionDocIds),
    )
  }
  return { targets, contents, plans }
}

export async function buildArchiveFromMemory(input: MemoryArchiveInput): Promise<ArchiveCheckpoint> {
  if (input.partitionId === null) {
    for (const vectorIndex of input.vectorIndexes.values()) await vectorIndex.completeGraph()
  }
  const captured = capture(input)
  const store = memoryCheckpointStore()
  const written = await writeCheckpointSegments({
    store,
    metadata: input.metadata,
    targets: captured.targets,
    compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
    prior: null,
    wholePartitions: captured.contents,
  })
  const vectors = await writeLiveVectors({ store, indexName: input.indexName, plans: captured.plans, priorVectors: [] })
  const refs: VectorFieldRef[] = vectors.refs
  await commitCheckpointManifest(store, input.metadata, written, refs)
  const manifestBytes = store.files.get(manifestKey(input.indexName))
  const decoded = manifestBytes === undefined ? null : await decodeSegmentManifest(manifestBytes, input.indexName)
  if (manifestBytes === undefined || decoded === null || decoded.kind !== 'current') {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The archive of index "${input.indexName}" holds no manifest`,
    )
  }
  return {
    manifestBytes,
    manifest: decoded.manifest,
    readFile: async ref => {
      const bytes = store.files.get(ref.key)
      if (bytes === undefined) {
        throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `The archive file "${ref.key}" is missing`, {
          key: ref.key,
        })
      }
      return bytes
    },
    readRange: async (ref, offset, length) => {
      const bytes = store.files.get(ref.key)
      if (bytes === undefined || offset + length > bytes.byteLength) {
        throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The archive file "${ref.key}" is missing`, {
          key: ref.key,
        })
      }
      return bytes.subarray(offset, offset + length)
    },
    release: () => store.files.clear(),
  }
}
