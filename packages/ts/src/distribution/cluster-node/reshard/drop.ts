import type { Narsil } from '../../../narsil'
import { clearEveryProgress } from '../../cluster/rebalance/generation'
import { readRebalanceRecord, updateRebalanceRecord } from '../../cluster/rebalance/records'
import type { ClusterCoordinator } from '../../coordinator/types'
import { localIndexIsGone } from '../local-index-gone'
import { routeDropIndex } from '../write-routing'

async function dropGenerationName(name: string, coordinator: ClusterCoordinator, engine: Narsil): Promise<void> {
  try {
    await routeDropIndex(name, coordinator, engine)
  } catch (error) {
    if (!localIndexIsGone(error)) throw error
  }
}

export async function dropServedIndex(name: string, coordinator: ClusterCoordinator, engine: Narsil): Promise<void> {
  const record = await readRebalanceRecord(coordinator, name)
  if (record !== null) {
    await updateRebalanceRecord(coordinator, name, record.jobId, current => ({ ...current, phase: 'aborting' }))
    const source = await coordinator.getAllocation(record.sourceGeneration)
    await dropGenerationName(record.targetGeneration, coordinator, engine)
    await clearEveryProgress(coordinator, name, source?.assignments.size ?? 0)
    await updateRebalanceRecord(coordinator, name, record.jobId, () => null)
  }
  const generation = (await coordinator.getAllocation(name))?.generation
  if (generation !== undefined) await dropGenerationName(generation, coordinator, engine)
  await routeDropIndex(name, coordinator, engine)
}
