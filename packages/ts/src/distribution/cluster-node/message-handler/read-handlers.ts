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
import { decodeRequestPayload } from '../../request-decode'
import type { RespondFn, TransportMessage } from '../../transport/types'
import { refuseEncodeWithoutRoom } from '../memory/answer-room'
import { wireParamsToLocal } from '../query-conversion'
import { localCountAnswer } from '../reads/count-answer'
import { listLocalPage } from '../reads/local-list-page'
import type { DataNodeHandlerDeps } from './types'

export async function handleCount(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateCountPayload(decodeRequestPayload(message.payload, message.type))
  const answer = await localCountAnswer(deps.engine, payload.indexName, payload.partitionIds)
  await respond(createCountResultMessage(answer, deps.nodeId, message.requestId))
}

export async function handleList(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateListPayload(decodeRequestPayload(message.payload, message.type))
  const page = await listLocalPage(deps.engine, payload)
  refuseEncodeWithoutRoom(page.entries.map(entry => entry.document))
  await respond(createListResultMessage(page, deps.nodeId, message.requestId))
}

export async function handleSuggest(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateSuggestPayload(decodeRequestPayload(message.payload, message.type))
  const result = await deps.analysisView.answerAt(payload.indexName, payload.analysisGeneration ?? 0, () =>
    deps.engine.suggestPartitions(
      payload.indexName,
      { prefix: payload.prefix, limit: payload.limit },
      payload.partitionIds,
    ),
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
  const payload = validatePreflightPayload(decodeRequestPayload(message.payload, message.type))
  const params = wireParamsToLocal(payload.params)
  const result = await deps.analysisView.answerAt(payload.indexName, payload.params.analysisGeneration ?? 0, () =>
    deps.engine.preflightPartitions(
      payload.indexName,
      params,
      payload.partitionIds,
      payload.params.indexBm25 ?? undefined,
    ),
  )

  await respond(
    createPreflightResultMessage(
      { count: result.count, analysisStale: result.analysisStale === true },
      deps.nodeId,
      message.requestId,
    ),
  )
}
