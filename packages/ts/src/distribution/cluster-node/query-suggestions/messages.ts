import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { historyStreamChunks } from '../../../query-suggestions/counts-stream'
import type { HistoryFiles } from '../../../query-suggestions/history-files'
import type { QuerySuggestionsRuntime } from '../../../query-suggestions/runtime'
import { decode } from '../../../serialization/msgpack'
import { validateIndexName } from '../../cluster/index-metadata'
import { encodeRebalanceRefusal } from '../../cluster/rebalance/reply'
import { isRecord } from '../../payload-guards'
import { type RespondFn, SuggestionMessageTypes, type TransportMessage } from '../../transport/types'
import { encodeErrorReplyFrom } from '../error-reply'

export interface CountsAnswerDeps {
  nodeId: string
  files: HistoryFiles
  saveDay(indexName: string): Promise<void>
}

export interface BuildAnswerDeps {
  nodeId: string
  isActive(): boolean
  runtime(): Promise<QuerySuggestionsRuntime>
  refresh(indexName: string): Promise<unknown>
  onError(error: unknown): void
}

function indexNameOf(message: TransportMessage): string {
  let decoded: unknown
  try {
    decoded = decode(message.payload)
  } catch {
    decoded = null
  }
  if (!isRecord(decoded) || typeof decoded.indexName !== 'string') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `A ${message.type} request needs "indexName" as a string`)
  }
  validateIndexName(decoded.indexName)
  return decoded.indexName
}

export async function answerCounts(deps: CountsAnswerDeps, message: TransportMessage, respond: RespondFn) {
  let indexName: string
  try {
    indexName = indexNameOf(message)
    await deps.saveDay(indexName)
  } catch (error) {
    await respond({
      type: `${message.type}.error`,
      sourceId: deps.nodeId,
      requestId: message.requestId,
      payload: encodeErrorReplyFrom(error, ErrorCodes.CONFIG_INVALID),
    })
    return
  }
  for await (const chunk of historyStreamChunks(deps.files, indexName)) {
    await respond({ type: message.type, sourceId: deps.nodeId, requestId: message.requestId, payload: chunk })
  }
}

async function startBuild(deps: BuildAnswerDeps, message: TransportMessage) {
  if (!deps.isActive()) {
    throw new NarsilError(ErrorCodes.NODE_NOT_CONTROLLER, `Node '${deps.nodeId}' does not hold the controller lease`, {
      nodeId: deps.nodeId,
    })
  }
  const indexName = indexNameOf(message)
  const runtime = await deps.runtime()
  await deps.refresh(indexName)
  const running = runtime.builds.begin(indexName, 'caller')
  await running.started
  return { buildId: running.build.buildId, status: running.build.status === 'skipped' ? 'skipped' : 'running' }
}

export function answerBuild(deps: BuildAnswerDeps, message: TransportMessage, respond: RespondFn): boolean {
  if (message.type !== SuggestionMessageTypes.BUILD) return false
  startBuild(deps, message)
    .then(
      result =>
        respond({ type: message.type, sourceId: deps.nodeId, requestId: message.requestId, payload: encode(result) }),
      error =>
        respond({
          type: `${message.type}.error`,
          sourceId: deps.nodeId,
          requestId: message.requestId,
          payload: encodeRebalanceRefusal(error),
        }),
    )
    .catch(deps.onError)
  return true
}
