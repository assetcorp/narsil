export type NarsilEventMap = {
  persistenceError: {
    indexName: string
    partitionId: number
    error: Error
    retriesExhausted: boolean
  }
  workerCrash: {
    workerId: number
    indexNames: string[]
    error: Error
  }
  workerPromote: {
    workerCount: number
    reason: string
  }
  workerPromoteFailure: {
    reason: string
    error: Error
    retryable: boolean
  }
  partitionRebalance: {
    indexName: string
    oldCount: number
    newCount: number
  }
  partitionWatermark: {
    indexName: string
    documentCount: number
    capacity: number
    partitionCount: number
  }
  durabilityError: {
    error: Error
  }
  invalidationError: {
    error: Error
  }
}
