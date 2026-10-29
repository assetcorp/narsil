import { ErrorCodes, NarsilError } from '../../../../errors'
import type { AllocationTable, ClusterCoordinator } from '../../../coordinator/types'
import { TEARDOWN_CAS_ATTEMPTS, TEARDOWN_RETRY_DELAY_MS, TEARDOWN_RETRY_ROUNDS } from '../../constants'
import { getIndexMetadata } from '../../index-metadata'
import { type EventLoopState, inSchemaQueue } from './state'

function scheduleTeardownRetry(
  indexName: string,
  coordinator: ClusterCoordinator,
  state: EventLoopState,
  isActive: () => boolean,
  round: number,
  onError?: (indexName: string, error: unknown) => void,
): void {
  const existing = state.teardownTimers.get(indexName)
  if (existing !== undefined) {
    clearTimeout(existing)
  }

  const timer = setTimeout(() => {
    state.teardownTimers.delete(indexName)
    inSchemaQueue(state, indexName, () =>
      tearDownAllocation(indexName, coordinator, state, isActive, round, onError),
    ).catch(error => {
      if (onError !== undefined) {
        onError(indexName, error)
      }
    })
  }, TEARDOWN_RETRY_DELAY_MS)
  timer.unref?.()
  state.teardownTimers.set(indexName, timer)
}

async function servesRecreatedIndex(coordinator: ClusterCoordinator, table: AllocationTable): Promise<boolean> {
  if (table.indexUuid === undefined) return false
  const metadata = await getIndexMetadata(coordinator, table.indexName)
  return metadata?.indexUuid === table.indexUuid
}

export async function tearDownAllocation(
  indexName: string,
  coordinator: ClusterCoordinator,
  state: EventLoopState,
  isActive: () => boolean,
  round: number,
  onError?: (indexName: string, error: unknown) => void,
): Promise<void> {
  const writerNodeId = state.controllerNodeId
  if (writerNodeId === null) {
    return
  }
  for (let attempt = 0; attempt < TEARDOWN_CAS_ATTEMPTS; attempt++) {
    if (!isActive()) {
      return
    }

    const currentTable = await coordinator.getAllocation(indexName)
    if (currentTable === null || (await servesRecreatedIndex(coordinator, currentTable))) {
      return
    }
    if (!isActive()) {
      return
    }

    if (currentTable.assignments.size > 0) {
      const emptyTable: AllocationTable = {
        indexName,
        version: currentTable.version + 1,
        replicationFactor: currentTable.replicationFactor,
        assignments: new Map(),
      }
      if (currentTable.indexUuid !== undefined) emptyTable.indexUuid = currentTable.indexUuid
      const written = await coordinator.putAllocation(indexName, emptyTable, currentTable.version, writerNodeId)
      if (!written) {
        continue
      }
      if (!isActive()) {
        return
      }
    }

    await coordinator.deleteAllocation(indexName)
    return
  }

  if (round + 1 < TEARDOWN_RETRY_ROUNDS && isActive()) {
    scheduleTeardownRetry(indexName, coordinator, state, isActive, round + 1, onError)
    return
  }

  throw new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `Teardown of the allocation for dropped index '${indexName}' lost every compare-and-set attempt`,
    { indexName, attempts: TEARDOWN_CAS_ATTEMPTS * TEARDOWN_RETRY_ROUNDS },
  )
}
