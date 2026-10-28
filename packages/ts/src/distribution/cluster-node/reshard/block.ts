import { ErrorCodes, NarsilError } from '../../../errors'
import { isHiddenGeneration, readRebalanceRecord } from '../../cluster/rebalance/records'
import type { ClusterCoordinator } from '../../coordinator/types'
import { partitionKey, type ReshardState, setReshardBlock } from './state'

export async function publicNameOf(
  state: ReshardState,
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<string | null> {
  if (!isHiddenGeneration(indexName)) return indexName
  const known = state.publicNames.get(indexName)
  if (known !== undefined) return known
  for (const name of await coordinator.listSchemas()) {
    if (isHiddenGeneration(name)) continue
    if ((await coordinator.getAllocation(name))?.generation === indexName) {
      state.publicNames.set(indexName, name)
      return name
    }
  }
  return null
}

export async function reconcileReshardBlock(
  state: ReshardState,
  coordinator: ClusterCoordinator,
  publicName: string,
  sourceGeneration: string,
  partitionId: number,
): Promise<void> {
  const key = partitionKey(sourceGeneration, partitionId)
  const marker = state.nextMarker
  const record = await readRebalanceRecord(coordinator, publicName)
  if (record !== null && record.sourceGeneration === sourceGeneration && record.phase === 'cutover') {
    if (!state.blocks.has(key)) setReshardBlock(state, sourceGeneration, record.jobId, partitionId)
    return
  }
  const block = state.blocks.get(key)
  if (block === undefined || block.marker > marker) return
  if (record === null) {
    const served = (await coordinator.getAllocation(publicName))?.generation
    if (served !== undefined && served !== sourceGeneration) return
  }
  if (state.blocks.get(key)?.marker === block.marker) state.blocks.delete(key)
}

async function checkNewTerm(
  state: ReshardState,
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionId: number,
  primaryTerm: number,
): Promise<void> {
  state.checkedTerms.set(partitionKey(indexName, partitionId), primaryTerm)
  try {
    const publicName = await publicNameOf(state, coordinator, indexName)
    if (publicName !== null) await reconcileReshardBlock(state, coordinator, publicName, indexName, partitionId)
  } catch (_) {}
}

export function rebalancingBackpressure(indexName: string, partitionId: number): NarsilError {
  return new NarsilError(
    ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
    `Partition ${partitionId} of index '${indexName}' refuses writes while its index moves to a new partition count`,
    { indexName, partitionId },
  )
}

export async function assertReshardOpen(
  state: ReshardState | undefined,
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionId: number,
  primaryTerm: number,
): Promise<void> {
  if (state === undefined) return
  const key = partitionKey(indexName, partitionId)
  if (state.checkedTerms.get(key) !== primaryTerm) {
    await checkNewTerm(state, coordinator, indexName, partitionId, primaryTerm)
  }
  if (state.blocks.has(key)) throw rebalancingBackpressure(indexName, partitionId)
}
