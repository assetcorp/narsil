import { RebalanceCheckpointHeld } from '../checkpoint-hold'
import type { WriteAheadQueue } from '../write-ahead-queue'
import type { PartitionManager } from './types'

const queues = new WeakMap<PartitionManager, WriteAheadQueue>()
const priorLayouts = new WeakMap<PartitionManager, number>()
const heldLayouts = new WeakSet<PartitionManager>()

export function registerCheckpointQueue(manager: PartitionManager, queue: WriteAheadQueue, holdsLayout = false): void {
  queues.set(manager, queue)
  priorLayouts.set(manager, manager.partitionCount)
  if (holdsLayout) heldLayouts.add(manager)
}

export function releaseCheckpointQueue(manager: PartitionManager, queue: WriteAheadQueue): void {
  if (queues.get(manager) !== queue) return
  queues.delete(manager)
  priorLayouts.delete(manager)
  heldLayouts.delete(manager)
}

export function releaseLayoutCheckpoint(manager: PartitionManager): void {
  heldLayouts.delete(manager)
}

export function metadataPartitionCount(manager: PartitionManager): number {
  return priorLayouts.get(manager) ?? manager.partitionCount
}

export function requiresLayoutCheckpoint(manager: PartitionManager): boolean {
  const prior = priorLayouts.get(manager)
  return prior !== undefined && prior !== manager.partitionCount
}

export async function captureAppliedPrefix<T>(
  manager: PartitionManager,
  capture: (cutoffs: ReadonlyMap<number, number>) => T | Promise<T>,
): Promise<T> {
  for (;;) {
    const queue = queues.get(manager)
    await queue?.settleAdmissions()
    const captured = await manager.publication.read(async () => {
      if (queue !== queues.get(manager) || (queue?.provisional ?? 0) > 0) return undefined
      queue?.requireSuccess()
      if (heldLayouts.has(manager)) throw new RebalanceCheckpointHeld()
      return { value: await capture(queue?.checkpointCutoffs(manager.partitionCount) ?? new Map()) }
    })
    if (captured !== undefined) return captured.value
  }
}

export async function requireCheckpointLayout(manager: PartitionManager | undefined): Promise<void> {
  if (manager !== undefined) await captureAppliedPrefix(manager, () => undefined)
}
