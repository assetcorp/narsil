import { ReplicationMessageTypes, type TransportConfig } from './types'

export function replyDeadlineMs(messageType: string, config: TransportConfig): number {
  if (messageType === ReplicationMessageTypes.ENTRY || messageType === ReplicationMessageTypes.ENTRY_BATCH) {
    return config.replicationTimeout
  }
  return config.requestTimeout
}

export function timeoutsOf(config: TransportConfig): TransportConfig {
  return {
    connectTimeout: config.connectTimeout,
    requestTimeout: config.requestTimeout,
    replicationTimeout: config.replicationTimeout,
    snapshotTimeout: config.snapshotTimeout,
  }
}
