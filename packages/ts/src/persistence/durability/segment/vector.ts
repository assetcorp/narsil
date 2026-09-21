import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { packSnapshotEnvelopeChunks, unpackEnvelopeBytes } from '../../../serialization/envelope'
import { HEADER_SIZE } from '../../../serialization/header'
import type {
  VectorCheckpointPlan,
  VectorGraphPayload,
  VectorIndex,
  WrittenVectorFile,
} from '../../../vector/vector-index'
import { decodeVectorFilePayload, decodeVectorGraphPayload } from '../../../vector/vector-index/checkpoint-payload'
import { countDead, deadBitsWhere, NO_LIVE_VECTOR_AT_POSITION } from '../../../vector/vector-index/dead-bits'
import type { DurableDirectory } from '../durable-filesystem'
import { vectorFileKey, vectorGraphKey } from './layout'
import type { VectorFieldRef, VectorFileRef } from './manifest'
import { chunksEndingInBytes, vectorPartChunks } from './vector-part-bytes'

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
  directory: DurableDirectory
  indexName: string
  plans: Map<string, VectorCheckpointPlan>
  priorVectors: readonly VectorFieldRef[]
}

function graphChunks(graph: VectorGraphPayload): Uint8Array[] {
  const last = graph.graphs[graph.graphs.length - 1]
  if (last === undefined) return chunksEndingInBytes(graph, graph, new Uint8Array(0))
  const emptied = { ...graph, graphs: [...graph.graphs.slice(0, -1), { ...last, neighbours: new Uint8Array(0) }] }
  return chunksEndingInBytes(graph, emptied, last.neighbours)
}

async function writeGraph(
  input: LiveVectorWriteInput,
  fieldPath: string,
  graph: VectorGraphPayload,
  generation: number,
): Promise<string> {
  const key = vectorGraphKey(input.indexName, fieldPath, generation)
  await input.directory.atomicWrite(key, await packSnapshotEnvelopeChunks(graphChunks(graph)))
  return key
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
  const files: VectorFileRef[] = plan.kept.map(file => ({ ...file }))
  const written: WrittenVectorFile[] = []
  for (let index = 0; index < plan.newFiles; index++) {
    const { payload, ordinals } = plan.readNewFile(index)
    const id = nextFileId
    nextFileId += 1
    const key = vectorFileKey(input.indexName, fieldPath, id)
    const envelope = await packSnapshotEnvelopeChunks(vectorPartChunks(payload))
    await input.directory.atomicWrite(key, envelope)
    let fileBytes = 0
    for (const chunk of envelope) fileBytes += chunk.length
    const dead = deadBitsWhere(ordinals.length, position => ordinals[position] === NO_LIVE_VECTOR_AT_POSITION)
    files.push({ id, key, count: payload.docIds.length, dead })
    written.push({ id, key, ordinals })
    outcome.layouts.push({
      fieldPath,
      key,
      docIds: payload.docIds,
      vectorsOffset: fileBytes - payload.vectors.byteLength,
    })
  }
  const priorGeneration = prior?.graphGeneration ?? 0
  const graphGeneration = plan.graph === null ? priorGeneration : priorGeneration + 1
  const graphKey = plan.graph === null ? null : await writeGraph(input, fieldPath, plan.graph, graphGeneration)
  outcome.refs.push({ fieldPath, nextFileId, files, graphGeneration, graphKey })
  outcome.written.push({ fieldPath, plan, files: written })
}

export async function writeLiveVectors(input: LiveVectorWriteInput): Promise<VectorWriteOutcome> {
  const outcome: VectorWriteOutcome = { refs: [], layouts: [], written: [] }
  for (const [fieldPath, plan] of input.plans) await writeField(input, fieldPath, plan, outcome)
  return outcome
}

function missing(what: string, key: string): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The ${what} "${key}" is missing`, { key })
}

function requireKey(what: string, found: string, expected: string): void {
  if (found === expected) return
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The manifest lists the ${what} under the wrong key`, {
    key: found,
    expected,
  })
}

function liveVectorsOf(ref: VectorFieldRef): number {
  let live = 0
  for (const file of ref.files) live += file.count - countDead(file.dead, file.count)
  return live
}

async function readGraph(
  directory: DurableDirectory,
  indexName: string,
  ref: VectorFieldRef,
): Promise<VectorGraphPayload | null> {
  if (ref.graphKey === null) return null
  requireKey('graph file', ref.graphKey, vectorGraphKey(indexName, ref.fieldPath, ref.graphGeneration))
  const bytes = await directory.read(ref.graphKey)
  if (bytes === null) missing('graph file', ref.graphKey)
  const { payloadBytes } = await unpackEnvelopeBytes(bytes)
  return decodeVectorGraphPayload(decode(payloadBytes))
}

export async function loadVectorField(
  directory: DurableDirectory,
  indexName: string,
  ref: VectorFieldRef,
  vectorIndex: VectorIndex,
): Promise<void> {
  const restore = vectorIndex.restoreCheckpoint({
    liveVectors: liveVectorsOf(ref),
    holdsGraph: ref.graphKey !== null,
  })
  for (const file of ref.files) {
    requireKey('vector file', file.key, vectorFileKey(indexName, ref.fieldPath, file.id))
    const bytes = await directory.read(file.key)
    if (bytes === null) missing('vector file', file.key)
    const { header, payloadBytes } = await unpackEnvelopeBytes(bytes)
    if (header.flags.compressionEnabled) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `The vector file "${file.key}" is compressed, and a field reads its vectors from the file at fixed offsets`,
        { key: file.key },
      )
    }
    const payload = decodeVectorFilePayload(decode(payloadBytes))
    if (payload.docIds.length !== file.count) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `The vector file "${file.key}" holds ${payload.docIds.length} vectors where the manifest counts ${file.count}`,
        { key: file.key, held: payload.docIds.length, count: file.count },
      )
    }
    restore.addFile({
      id: file.id,
      key: file.key,
      payload,
      dead: file.dead,
      location: {
        path: await directory.pathOf(file.key),
        vectorsOffset: HEADER_SIZE + header.payloadLength - payload.vectors.byteLength,
      },
    })
  }
  restore.finish(await readGraph(directory, indexName, ref))
}
