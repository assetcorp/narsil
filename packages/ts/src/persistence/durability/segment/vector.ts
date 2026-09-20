import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { packSnapshotEnvelopeChunks, unpackEnvelopeBytes } from '../../../serialization/envelope'
import { HEADER_SIZE } from '../../../serialization/header'
import type { VectorIndexPartsPlan, VectorIndexPayload, VectorPartFile } from '../../../vector/vector-index'
import { decodeVectorIndexPart } from '../../../vector/vector-index/payload'
import type { DurableDirectory } from '../durable-filesystem'
import { vectorSegmentKey } from './layout'
import type { VectorSegmentRef } from './manifest'
import { vectorPartChunks } from './vector-part-bytes'

export interface VectorCheckpointLayout {
  fieldPath: string
  key: string
  docIds: string[]
  vectorsOffset: number
}

export interface VectorWriteOutcome {
  refs: VectorSegmentRef[]
  layouts: VectorCheckpointLayout[]
}

export interface VectorPartsRead {
  parts: VectorIndexPayload[]
  files: VectorPartFile[]
}

function vectorBytesOf(part: VectorIndexPayload): number {
  return part.docIds.length * part.dimension * 4
}

export async function readVectorParts(directory: DurableDirectory, keys: readonly string[]): Promise<VectorPartsRead> {
  const parts: VectorIndexPayload[] = []
  const files: VectorPartFile[] = []
  for (const key of keys) {
    const bytes = await directory.read(key)
    if (bytes === null) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The vector part "${key}" is missing`, { key })
    }
    const { header, payloadBytes } = await unpackEnvelopeBytes(bytes)
    const part = decodeVectorIndexPart(decode(payloadBytes))
    parts.push(part)
    files.push({
      path: await directory.pathOf(key),
      vectorsOffset: HEADER_SIZE + header.payloadLength - vectorBytesOf(part),
    })
  }
  return { parts, files }
}

export interface LiveVectorWriteInput {
  directory: DurableDirectory
  indexName: string
  plans: Map<string, VectorIndexPartsPlan>
  priorVectors: readonly VectorSegmentRef[]
}

async function writeFieldParts(
  input: LiveVectorWriteInput,
  fieldPath: string,
  plan: VectorIndexPartsPlan,
  outcome: VectorWriteOutcome,
): Promise<void> {
  const prior = input.priorVectors.find(ref => ref.fieldPath === fieldPath)
  const generation = (prior?.generation ?? 0) + 1
  const keys: string[] = []
  for (let index = 0; index < plan.parts; index++) {
    const part = plan.readPart(index)
    const key = vectorSegmentKey(input.indexName, fieldPath, generation, part.part)
    const envelope = await packSnapshotEnvelopeChunks(vectorPartChunks(part))
    await input.directory.atomicWrite(key, envelope)
    keys.push(key)
    let fileBytes = 0
    for (const chunk of envelope) fileBytes += chunk.length
    outcome.layouts.push({ fieldPath, key, docIds: part.docIds, vectorsOffset: fileBytes - vectorBytesOf(part) })
  }
  outcome.refs.push({ fieldPath, generation, keys })
}

export async function writeLiveVectors(input: LiveVectorWriteInput): Promise<VectorWriteOutcome> {
  const outcome: VectorWriteOutcome = { refs: [], layouts: [] }
  for (const [fieldPath, plan] of input.plans) await writeFieldParts(input, fieldPath, plan, outcome)
  return outcome
}
