import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { MAX_PARTITION_COUNT } from '../../constants'
import { isRecord, isValidInteger } from '../../payload-guards'
import { decodeRequestPayload } from '../../request-decode'
import type { RespondFn, TransportMessage } from '../../transport/types'
import { blockForLeadHandoff, type LeadHandoffRequest, liftLeadHandoff } from '../write-routing/lead-handoff'
import type { DataNodeHandlerDeps } from './types'

function invalid(what: string): NarsilError {
  return new NarsilError(ErrorCodes.CONFIG_INVALID, `Invalid lead handover message: ${what}`)
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

function readLeadHandoff(message: TransportMessage): LeadHandoffRequest {
  const record = decodeRequestPayload(message.payload, message.type)
  if (!isRecord(record)) throw invalid('expected an object')
  if (record.action !== 'block' && record.action !== 'lift') throw invalid('"action" must be "block" or "lift"')
  return {
    indexName: text(record, 'indexName'),
    partitionId: count(record, 'partitionId', 0, MAX_PARTITION_COUNT - 1),
    primaryTerm: count(record, 'primaryTerm', 1, Number.MAX_SAFE_INTEGER),
    targetNodeId: text(record, 'targetNodeId'),
    action: record.action,
  }
}

export async function handleLeadHandoff(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const handoff = readLeadHandoff(message)
  let end = { lastSeqNo: 0, lastPrimaryTerm: 0 }
  if (handoff.action === 'block') end = await blockForLeadHandoff(deps.writeDeps, handoff)
  else liftLeadHandoff(deps.writeDeps, handoff)
  await respond({
    type: message.type,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode({ partitionId: handoff.partitionId, ...end }),
  })
}
