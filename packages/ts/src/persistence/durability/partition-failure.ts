import type { PartitionFailureHandler } from './types'

export interface PartitionFailureRouting {
  isolate(onFailed: PartitionFailureHandler): void
  failsAlone(indexName: string, partitionId: number, error: Error): boolean
}

export function createPartitionFailureRouting(): PartitionFailureRouting {
  let onFailed: PartitionFailureHandler | null = null
  return {
    isolate(handler) {
      onFailed = handler
    },
    failsAlone(indexName, partitionId, error) {
      if (onFailed === null) return false
      onFailed(indexName, partitionId, error)
      return true
    },
  }
}
