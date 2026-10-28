import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import {
  createAckMessage,
  createForwardBatchResultMessage,
  validateEntryBatchPayload,
  validateEntryPayload,
  validateForwardBatchPayload,
} from '../../replication/codec'
import { validateReplicationEntry } from '../../replication/replica'
import type { ReplicationLogEntry } from '../../replication/types'
import type { ForwardPayload, RespondFn, TransportMessage } from '../../transport/types'
import { ReplicationMessageTypes } from '../../transport/types'
import { applyForwardedBatch, applyForwardedWrite } from '../write-routing'
import { resolveValidatedAssignment } from './entry-authority'
import type { DataNodeHandlerDeps } from './types'

export async function handleForward(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as Record<string, unknown>
  const payload = validateForwardPayload(decoded)
  const documentId = await applyForwardedWrite(payload, deps.writeDeps)

  await respond({
    type: ReplicationMessageTypes.FORWARD,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode({ documentId, success: true }),
  })
}

export async function handleForwardBatch(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateForwardBatchPayload(decode(message.payload))
  const results = await applyForwardedBatch(payload, deps.writeDeps)
  await respond(createForwardBatchResultMessage({ results }, deps.nodeId, message.requestId))
}

export async function handleReplicationEntry(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateEntryPayload(decode(message.payload))
  const { entry } = payload

  await resolveValidatedAssignment(entry, message.sourceId, deps)
  await applyEntryToLog(entry, deps)

  await respond(createAckMessage(entry.seqNo, entry.partitionId, entry.indexName, deps.nodeId, message.requestId))
}

export async function handleReplicationEntryBatch(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateEntryBatchPayload(decode(message.payload))
  const firstEntry = payload.entries[0]
  const lastEntry = payload.entries[payload.entries.length - 1]

  await resolveValidatedAssignment(firstEntry, message.sourceId, deps)
  for (const entry of payload.entries) {
    await applyEntryToLog(entry, deps)
  }

  await respond(
    createAckMessage(lastEntry.seqNo, lastEntry.partitionId, lastEntry.indexName, deps.nodeId, message.requestId),
  )
}

async function applyEntryToLog(entry: ReplicationLogEntry, deps: DataNodeHandlerDeps): Promise<void> {
  let log = deps.writeDeps.getReplicationLog(entry.indexName, entry.partitionId)
  const existing = log.getEntry(entry.seqNo)
  if (existing !== undefined) {
    if (existing.checksum !== entry.checksum) {
      throw new NarsilError(
        ErrorCodes.REPLICATION_ENTRY_INVALID,
        `Conflicting replication entry at sequence number ${entry.seqNo}`,
        { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo },
      )
    }
    return
  }

  const expectedSeqNo = log.localLogEnd + 1
  if (entry.seqNo !== expectedSeqNo) {
    const canSeedFromCompletedBootstrap =
      log.entryCount === 0 &&
      entry.seqNo > expectedSeqNo &&
      deps.isBootstrapSynced?.(entry.indexName, entry.partitionId) === true

    if (!canSeedFromCompletedBootstrap) {
      throw new NarsilError(
        ErrorCodes.REPLICATION_ENTRY_INVALID,
        `Out-of-order replication entry ${entry.seqNo}; expected ${expectedSeqNo}`,
        { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo, expectedSeqNo },
      )
    }

    deps.writeDeps.resetReplicationLog(entry.indexName, entry.partitionId, entry.seqNo, entry.primaryTerm)
    log = deps.writeDeps.getReplicationLog(entry.indexName, entry.partitionId)
  }

  const validation = validateReplicationEntry(entry, log.localLogEndPrimaryTerm, log)
  if (!validation.valid) {
    throw new NarsilError(
      validation.error ?? ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Invalid replication entry ${entry.seqNo}`,
      { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo },
    )
  }

  await deps.engine.applyReplicationEntry(entry)
  log.appendCommitted(entry)
}

export function validateForwardPayload(decoded: unknown): ForwardPayload {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: expected an object')
  }
  const record = decoded as Record<string, unknown>
  if (typeof record.indexName !== 'string' || record.indexName.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: "indexName" must be a non-empty string')
  }
  if (typeof record.documentId !== 'string' || record.documentId.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: "documentId" must be a non-empty string')
  }
  if (record.operation !== 'insert' && record.operation !== 'remove' && record.operation !== 'update') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid ForwardPayload: "operation" must be "insert", "remove", or "update"',
    )
  }
  return decoded as unknown as ForwardPayload
}
