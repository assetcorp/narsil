import type { PartitionManager } from './manager'
import { createPublicationGate } from './manager/publication-gate'

interface DurableRouting {
  gate: ReturnType<typeof createPublicationGate>
  partitionCount: number | null
  failure: Error | null
}

const routings = new WeakMap<PartitionManager, DurableRouting>()

function routingOf(manager: PartitionManager): DurableRouting {
  let routing = routings.get(manager)
  if (routing === undefined) {
    routing = { gate: createPublicationGate(), partitionCount: null, failure: null }
    routings.set(manager, routing)
  }
  return routing
}

export function beginDurableRebalance(manager: PartitionManager): void {
  routingOf(manager).partitionCount = manager.partitionCount
}

export function finishDurableRebalance(manager: PartitionManager): void {
  routingOf(manager).partitionCount = null
}

export function admitDurableWrite<T>(
  manager: PartitionManager | undefined,
  write: (partitionCount: number) => Promise<T>,
): Promise<T> {
  if (manager === undefined) return write(1)
  const routing = routingOf(manager)
  return routing.gate.read(() => {
    if (routing.failure !== null) throw routing.failure
    return write(routing.partitionCount ?? manager.partitionCount)
  })
}

export function switchDurableRouting(
  manager: PartitionManager,
  commit: (oldPartitionCount: number) => Promise<void>,
): Promise<void> {
  const routing = routingOf(manager)
  return routing.gate.write(async () => {
    try {
      await commit(routing.partitionCount ?? manager.partitionCount)
      routing.partitionCount = manager.partitionCount
    } catch (error) {
      routing.failure = error instanceof Error ? error : new Error(String(error))
      throw error
    }
  })
}
