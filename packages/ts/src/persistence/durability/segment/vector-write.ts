import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { packChecksummedEnvelope } from '../../../serialization/envelope-file'
import type { VectorCheckpointPlan, WrittenVectorFile } from '../../../vector/vector-index'
import { deadBitsWhere, NO_LIVE_VECTOR_AT_POSITION } from '../../../vector/vector-index/dead-bits'
import { graphPartKey, vectorFileKey } from './layout'
import type { FileRef, VectorFieldRef, VectorFileRef } from './manifest'
import type { CheckpointStore } from './store'
import { GRAPH_PART_ENVELOPE_VERSION, VECTOR_FILE_ENVELOPE_VERSION } from './vector-load'
import { vectorPartChunks } from './vector-part-bytes'

export interface VectorCheckpointLayout {
  fieldPath: string
  key: string
  docIds: string[]
  vectorsOffset: number
}

export interface VectorFieldWritten {
  fieldPath: string
  plan: VectorCheckpointPlan
  files: WrittenVectorFile[]
}

export interface VectorWriteOutcome {
  refs: VectorFieldRef[]
  layouts: VectorCheckpointLayout[]
  written: VectorFieldWritten[]
}

export interface LiveVectorWriteInput {
  store: CheckpointStore
  indexName: string
  plans: Map<string, VectorCheckpointPlan>
  priorVectors: readonly VectorFieldRef[]
  priorFileRefs?: ReadonlyMap<string, FileRef>
}

function keptFileRef(
  input: LiveVectorWriteInput,
  prior: VectorFieldRef | undefined,
  kept: VectorCheckpointPlan['kept'][number],
): VectorFileRef {
  const listed = prior?.files.find(file => file.key === kept.key) ?? input.priorFileRefs?.get(kept.key)
  if (listed === undefined) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The checkpoint keeps the vector file "${kept.key}", which the previous manifest does not list`,
      { key: kept.key },
    )
  }
  return { ...kept, bytes: listed.bytes, checksum: listed.checksum }
}

async function writeGraphParts(
  input: LiveVectorWriteInput,
  fieldPath: string,
  plan: VectorCheckpointPlan,
  generation: number,
): Promise<FileRef[]> {
  const parts = plan.graphParts ?? []
  const refs: FileRef[] = []
  for (let part = 0; part < parts.length; part++) {
    const key = graphPartKey(input.indexName, fieldPath, generation, part)
    const packed = await packChecksummedEnvelope(
      [encode(parts[part])],
      GRAPH_PART_ENVELOPE_VERSION,
      `graph part "${key}"`,
    )
    await input.store.write(key, packed.chunks)
    refs.push({ key, bytes: packed.byteLength, checksum: packed.checksum })
  }
  return refs
}

async function writeField(
  input: LiveVectorWriteInput,
  fieldPath: string,
  plan: VectorCheckpointPlan,
  outcome: VectorWriteOutcome,
): Promise<void> {
  const prior = input.priorVectors.find(ref => ref.fieldPath === fieldPath)
  if (plan.unchanged && prior !== undefined) {
    outcome.refs.push(prior)
    return
  }
  let nextFileId = prior?.nextFileId ?? 0
  const files: VectorFileRef[] = plan.kept.map(kept => keptFileRef(input, prior, kept))
  const written: WrittenVectorFile[] = []
  for (let index = 0; index < plan.newFiles; index++) {
    const { payload, ordinals } = plan.readNewFile(index)
    const id = nextFileId
    nextFileId += 1
    const key = vectorFileKey(input.indexName, fieldPath, id)
    const packed = await packChecksummedEnvelope(
      vectorPartChunks(payload),
      VECTOR_FILE_ENVELOPE_VERSION,
      `vector file "${key}"`,
    )
    await input.store.write(key, packed.chunks)
    const dead = deadBitsWhere(ordinals.length, position => ordinals[position] === NO_LIVE_VECTOR_AT_POSITION)
    files.push({ id, key, count: payload.docIds.length, dead, bytes: packed.byteLength, checksum: packed.checksum })
    written.push({ id, key, ordinals })
    outcome.layouts.push({
      fieldPath,
      key,
      docIds: payload.docIds,
      vectorsOffset: packed.byteLength - payload.vectors.byteLength,
    })
  }
  const priorGeneration = prior?.graphGeneration ?? 0
  const holdsGraph = plan.graphParts !== null && plan.graphParts.length > 0
  const graphGeneration = holdsGraph ? priorGeneration + 1 : priorGeneration
  const graphParts = holdsGraph ? await writeGraphParts(input, fieldPath, plan, graphGeneration) : []
  outcome.refs.push({ fieldPath, nextFileId, files, graphGeneration, graphParts })
  outcome.written.push({ fieldPath, plan, files: written })
}

export async function writeLiveVectors(input: LiveVectorWriteInput): Promise<VectorWriteOutcome> {
  const outcome: VectorWriteOutcome = { refs: [], layouts: [], written: [] }
  for (const [fieldPath, plan] of input.plans) await writeField(input, fieldPath, plan, outcome)
  return outcome
}
