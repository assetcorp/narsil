import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { MAX_PARTITION_COUNT } from '../../constants'
import { isRecord, isValidInteger } from '../../payload-guards'
import { createForwardBatchResultMessage } from '../../replication/codec'
import type {
  ReshardCutoverPayload,
  ReshardCutoverResultPayload,
  ReshardForwardOperation,
  ReshardForwardPayload,
  ReshardPurgePayload,
  ReshardPurgeResultPayload,
  ReshardStartPayload,
  ReshardStartResultPayload,
} from '../../transport/reshard-payloads'
import type { RespondFn, TransportMessage } from '../../transport/types'
import type { DataNodeHandlerDeps } from '../message-handler/types'
import { applyReshardCutover, startReshardCopy } from './source'
import { applyReshardForward, purgeReshardSource } from './target'

function invalid(what: string): NarsilError {
  return new NarsilError(ErrorCodes.CONFIG_INVALID, `Invalid partition copy message: ${what}`)
}

function decodedRecord(message: TransportMessage): Record<string, unknown> {
  let decoded: unknown
  try {
    decoded = decode(message.payload)
  } catch (_) {
    decoded = null
  }
  if (!isRecord(decoded)) throw invalid('expected an object')
  return decoded
}

function text(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) throw invalid(`"${field}" must be a non-empty string`)
  return value
}

function count(record: Record<string, unknown>, field: string, minimum: number, maximum: number): number {
  const value = record[field]
  if (!isValidInteger(value) || value < minimum || value > maximum) {
    throw invalid(`"${field}" must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function readStart(message: TransportMessage): ReshardStartPayload {
  const record = decodedRecord(message)
  const sourcePartitionCount = count(record, 'sourcePartitionCount', 1, MAX_PARTITION_COUNT)
  return {
    indexName: text(record, 'indexName'),
    jobId: text(record, 'jobId'),
    sourceGeneration: text(record, 'sourceGeneration'),
    targetGeneration: text(record, 'targetGeneration'),
    partitionId: count(record, 'partitionId', 0, sourcePartitionCount - 1),
    sourcePartitionCount,
    targetPartitionCount: count(record, 'targetPartitionCount', 1, MAX_PARTITION_COUNT),
  }
}

function readOperation(value: unknown): ReshardForwardOperation {
  if (!isRecord(value)) throw invalid('each operation must be an object')
  const documentId = text(value, 'documentId')
  if (value.operation === 'remove') return { documentId, operation: 'remove' }
  if (value.operation !== 'replace' || !(value.document instanceof Uint8Array)) {
    throw invalid('an operation must be a replace that carries its document, or a remove')
  }
  return { documentId, operation: 'replace', document: value.document }
}

function readForward(message: TransportMessage): ReshardForwardPayload {
  const record = decodedRecord(message)
  if (!Array.isArray(record.operations)) throw invalid('"operations" must be a list')
  return {
    targetGeneration: text(record, 'targetGeneration'),
    jobId: text(record, 'jobId'),
    sourcePartitionId: count(record, 'sourcePartitionId', 0, MAX_PARTITION_COUNT - 1),
    sourcePrimaryTerm: count(record, 'sourcePrimaryTerm', 0, Number.MAX_SAFE_INTEGER),
    operations: record.operations.map(readOperation),
  }
}

function readCutover(message: TransportMessage): ReshardCutoverPayload {
  const record = decodedRecord(message)
  if (record.action !== 'block' && record.action !== 'lift') throw invalid('"action" must be "block" or "lift"')
  return {
    indexName: text(record, 'indexName'),
    jobId: text(record, 'jobId'),
    partitionId: count(record, 'partitionId', 0, MAX_PARTITION_COUNT - 1),
    action: record.action,
  }
}

function readPurge(message: TransportMessage): ReshardPurgePayload {
  const record = decodedRecord(message)
  const sourcePartitionCount = count(record, 'sourcePartitionCount', 1, MAX_PARTITION_COUNT)
  return {
    targetGeneration: text(record, 'targetGeneration'),
    jobId: text(record, 'jobId'),
    sourcePartitionCount,
    sourcePartitionId: count(record, 'sourcePartitionId', 0, sourcePartitionCount - 1),
  }
}

function sourceDeps(deps: DataNodeHandlerDeps) {
  return { writeDeps: deps.writeDeps, engine: deps.engine, onError: deps.onError }
}

function reply(deps: DataNodeHandlerDeps, message: TransportMessage, payload: unknown): TransportMessage {
  return { type: message.type, sourceId: deps.nodeId, requestId: message.requestId, payload: encode(payload) }
}

export async function handleReshardStart(message: TransportMessage, respond: RespondFn, deps: DataNodeHandlerDeps) {
  const payload = readStart(message)
  const snapshotSeqNo = await startReshardCopy(sourceDeps(deps), payload)
  const result: ReshardStartResultPayload = { jobId: payload.jobId, partitionId: payload.partitionId, snapshotSeqNo }
  await respond(reply(deps, message, result))
}

export async function handleReshardForward(message: TransportMessage, respond: RespondFn, deps: DataNodeHandlerDeps) {
  const results = await applyReshardForward(deps.writeDeps, deps.engine, readForward(message))
  await respond({ ...createForwardBatchResultMessage({ results }, deps.nodeId, message.requestId), type: message.type })
}

export async function handleReshardCutover(message: TransportMessage, respond: RespondFn, deps: DataNodeHandlerDeps) {
  const payload = readCutover(message)
  const lastSeqNo = await applyReshardCutover(sourceDeps(deps), payload)
  const result: ReshardCutoverResultPayload = { jobId: payload.jobId, partitionId: payload.partitionId, lastSeqNo }
  await respond(reply(deps, message, result))
}

export async function handleReshardPurge(message: TransportMessage, respond: RespondFn, deps: DataNodeHandlerDeps) {
  const removed = await purgeReshardSource(deps.writeDeps, deps.engine, readPurge(message))
  const result: ReshardPurgeResultPayload = { removed }
  await respond(reply(deps, message, result))
}
