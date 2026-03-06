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
  partitionRebalance: {
    indexName: string
    oldCount: number
    newCount: number
  }
}
