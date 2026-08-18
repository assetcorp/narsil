export interface PartitionWriteQueues {
  chains: Map<string, Promise<void>>
}

export function createPartitionWriteQueues(): PartitionWriteQueues {
  return { chains: new Map() }
}

export function enqueuePartitionWrite<T>(
  queues: PartitionWriteQueues,
  indexName: string,
  partitionId: number,
  task: () => Promise<T>,
): Promise<T> {
  const key = `${indexName}:${partitionId}`
  const previous = queues.chains.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const chain = run.then(
    () => undefined,
    () => undefined,
  )
  queues.chains.set(key, chain)
  chain.then(() => {
    if (queues.chains.get(key) === chain) {
      queues.chains.delete(key)
    }
  })
  return run
}
