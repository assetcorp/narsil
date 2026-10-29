import { ReplicationMessageTypes, type TransportConfig } from './types'

export function replyDeadlineMs(messageType: string, config: TransportConfig): number {
  if (messageType === ReplicationMessageTypes.ENTRY || messageType === ReplicationMessageTypes.ENTRY_BATCH) {
    return config.replicationTimeout
  }
  return config.requestTimeout
}
