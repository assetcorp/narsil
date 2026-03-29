export interface PersistenceAdapter {
  save(key: string, data: Uint8Array): Promise<void>
  load(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

export interface InvalidationAdapter {
  publish(event: InvalidationEvent): Promise<void>
  subscribe(handler: (event: InvalidationEvent) => void): Promise<void>
  shutdown(): Promise<void>
}

export type InvalidationEvent =
  | {
      type: 'partition'
      indexName: string
      partitions: number[]
      timestamp: number
      sourceInstanceId: string
    }
  | {
      type: 'statistics'
      indexName: string
      instanceId: string
      stats: PartitionStatistics
    }

export interface PartitionStatistics {
  totalDocs: number
  docFrequencies: Record<string, number>
  totalFieldLengths: Record<string, number>
}

export interface EmbeddingAdapter {
  embed(input: string, purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array>
  embedBatch?(inputs: string[], purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>
  readonly dimensions: number
  shutdown?(): Promise<void>
}
