import { decode } from '@msgpack/msgpack'
import { normalizeSort, readSortValues } from '../../../search/sorting'
import type { AnyDocument } from '../../../types/schema'
import type { ListParams } from '../../../types/search'
import {
  createCountResultMessage,
  createListResultMessage,
  createPreflightResultMessage,
  createSuggestResultMessage,
  validateCountPayload,
  validateListPayload,
  validatePreflightPayload,
  validateSuggestPayload,
} from '../../query/codec'
import type { ListEntryWire, RespondFn, TransportMessage } from '../../transport/types'
import { wireParamsToLocal } from '../query-conversion'
import type { DataNodeHandlerDeps } from './types'

export async function handleCount(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateCountPayload(decode(message.payload))
  const requested = new Set(payload.partitionIds)
  const partitions = (await deps.engine.partitionStatsForRead(payload.indexName))
    .filter(partition => requested.has(partition.partitionId))
    .map(partition => ({
      partitionId: partition.partitionId,
      documentCount: partition.documentCount,
      estimatedMemoryBytes: partition.estimatedMemoryBytes,
    }))
  const language = deps.engine.getStats(payload.indexName).language

  await respond(createCountResultMessage({ partitions, language }, deps.nodeId, message.requestId))
}

export async function handleList(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateListPayload(decode(message.payload))

  const listParams: ListParams = {
    cursor: payload.cursor ?? undefined,
    limit: payload.limit,
    filters: payload.filters ?? undefined,
    sort: payload.sort ?? undefined,
    document: payload.fields === null ? undefined : { include: payload.fields },
  }

  const result = await deps.engine.listPartitions(payload.indexName, listParams, payload.partitionIds)
  const sortFields = payload.sort === null ? null : normalizeSort(payload.sort).map(entry => entry.field)

  const entries: ListEntryWire[] = result.documents.map(listed => ({
    docId: listed.id,
    document: listed.document as Record<string, unknown>,
    sortValues:
      sortFields === null
        ? null
        : readSortValues(listed.document as AnyDocument | undefined, sortFields).map(toWireSortValue),
  }))

  await respond(
    createListResultMessage(
      { entries, total: result.total, hasMore: result.cursor !== null },
      deps.nodeId,
      message.requestId,
    ),
  )
}

export async function handleSuggest(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateSuggestPayload(decode(message.payload))
  const result = await deps.engine.suggestPartitions(
    payload.indexName,
    { prefix: payload.prefix, limit: payload.limit },
    payload.partitionIds,
  )

  await respond(
    createSuggestResultMessage(
      { terms: result.terms, analysisStale: result.analysisStale === true },
      deps.nodeId,
      message.requestId,
    ),
  )
}

export async function handlePreflight(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validatePreflightPayload(decode(message.payload))
  const params = wireParamsToLocal(payload.params)
  const result = await deps.engine.preflightPartitions(payload.indexName, params, payload.partitionIds)

  await respond(
    createPreflightResultMessage(
      { count: result.count, analysisStale: result.analysisStale === true },
      deps.nodeId,
      message.requestId,
    ),
  )
}

function toWireSortValue(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  return null
}
