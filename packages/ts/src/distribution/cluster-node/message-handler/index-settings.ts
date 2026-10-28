import { decode } from '@msgpack/msgpack'
import { createIndexSettingsResultMessage, validateIndexSettingsPayload } from '../../cluster/index-settings-message'
import type { RespondFn, TransportMessage } from '../../transport/types'
import { applyStoredSynonyms } from '../synonym-sets'
import type { DataNodeHandlerDeps } from './types'

export async function handleIndexSettings(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateIndexSettingsPayload(decode(message.payload))
  const applied =
    payload !== null && (await applyStoredSynonyms(deps.engine, deps.coordinator, payload.indexName, payload.indexUuid))
  const indexName = payload?.indexName ?? ''
  await respond(createIndexSettingsResultMessage({ indexName, applied }, deps.nodeId, message.requestId))
}
