import { encode } from '@msgpack/msgpack'
import { isRecord } from '../payload-guards'
import type { IndexSettingsPayload, IndexSettingsResultPayload, TransportMessage } from '../transport/types'
import { ClusterMessageTypes } from '../transport/types'

export function validateIndexSettingsPayload(decoded: unknown): IndexSettingsPayload | null {
  if (!isRecord(decoded)) return null
  const { indexName, indexUuid } = decoded
  if (typeof indexName !== 'string' || indexName.length === 0) return null
  if (typeof indexUuid !== 'string' || indexUuid.length === 0) return null
  return { indexName, indexUuid }
}

export function validateIndexSettingsResultPayload(decoded: unknown): IndexSettingsResultPayload | null {
  if (!isRecord(decoded)) return null
  const { indexName, applied } = decoded
  if (typeof indexName !== 'string' || typeof applied !== 'boolean') return null
  return { indexName, applied }
}

export function createIndexSettingsMessage(
  payload: IndexSettingsPayload,
  sourceNodeId: string,
  requestId: string,
): TransportMessage {
  return { type: ClusterMessageTypes.INDEX_SETTINGS, sourceId: sourceNodeId, requestId, payload: encode(payload) }
}

export function createIndexSettingsResultMessage(
  result: IndexSettingsResultPayload,
  sourceNodeId: string,
  requestId: string,
): TransportMessage {
  return { type: ClusterMessageTypes.INDEX_SETTINGS, sourceId: sourceNodeId, requestId, payload: encode(result) }
}
