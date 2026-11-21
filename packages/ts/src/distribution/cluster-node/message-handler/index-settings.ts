import { ErrorCodes, NarsilError } from '../../../errors'
import { createIndexSettingsResultMessage, validateIndexSettingsPayload } from '../../cluster/index-settings-message'
import { decodeRequestPayload } from '../../request-decode'
import type { RespondFn, TransportMessage } from '../../transport/types'
import { applyStoredSynonyms } from '../synonym-sets'
import type { DataNodeHandlerDeps } from './types'

export async function handleIndexSettings(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateIndexSettingsPayload(decodeRequestPayload(message.payload, message.type))
  if (payload === null) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid IndexSettingsPayload: it needs an indexName and an indexUuid that are non-empty strings',
    )
  }
  const applied = await applyStoredSynonyms(deps.engine, deps.coordinator, payload.indexName, payload.indexUuid)
  await respond(
    createIndexSettingsResultMessage({ indexName: payload.indexName, applied }, deps.nodeId, message.requestId),
  )
}
