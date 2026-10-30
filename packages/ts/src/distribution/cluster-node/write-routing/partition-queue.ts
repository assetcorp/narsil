export interface PartitionWriteQueues {
  chains: Map<string, Promise<void>>
}

export type HoldPartitionQueue = (settled: Promise<unknown>) => void

export function createPartitionWriteQueues(): PartitionWriteQueues {
  return { chains: new Map() }
}

export function enqueuePartitionWrite<T>(
  queues: PartitionWriteQueues,
  indexName: string,
  partitionId: number,
  task: (hold: HoldPartitionQueue) => Promise<T>,
): Promise<T> {
  const key = `${indexName}:${partitionId}`
  const previous = queues.chains.get(key) ?? Promise.resolve()
  const holds: Promise<unknown>[] = []
  const hold: HoldPartitionQueue = settled => {
    holds.push(settled.catch(() => undefined))
  }
  const run = previous.then(
    () => task(hold),
    () => task(hold),
  )
  const chain = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => Promise.all(holds))
    .then(() => undefined)
  queues.chains.set(key, chain)
  chain.then(() => {
    if (queues.chains.get(key) === chain) {
      queues.chains.delete(key)
    }
  })
  return run
}
