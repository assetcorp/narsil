export interface ReplicaFeedClock {
  noteFed(indexName: string, partitionId: number): void
  unfedForMs(indexName: string, partitionId: number): number
  forget(indexName: string, partitionId: number): void
}

function feedKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

export function createReplicaFeedClock(): ReplicaFeedClock {
  const fedAt = new Map<string, number>()
  return {
    noteFed(indexName, partitionId) {
      fedAt.set(feedKey(indexName, partitionId), Date.now())
    },
    unfedForMs(indexName, partitionId) {
      const key = feedKey(indexName, partitionId)
      const at = fedAt.get(key)
      if (at !== undefined) return Date.now() - at
      fedAt.set(key, Date.now())
      return 0
    },
    forget(indexName, partitionId) {
      fedAt.delete(feedKey(indexName, partitionId))
    },
  }
}
