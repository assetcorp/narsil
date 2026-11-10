import type { PartitionManager } from '../partitioning/manager'

const generations = new WeakMap<PartitionManager, number>()

export function copyGenerationOf(manager: PartitionManager): number {
  return generations.get(manager) ?? 0
}

export function advanceCopyGeneration(manager: PartitionManager): number {
  const generation = copyGenerationOf(manager) + 1
  generations.set(manager, generation)
  return generation
}
