import { ErrorCodes, NarsilError } from '../../../../errors'
import type { AllocationTable, ClusterCoordinator, NodeRegistration, SchemaEvent } from '../../../coordinator/types'
import { allocate } from '../../allocator/index'
import { getIndexMetadata } from '../../index-metadata'
import type { EventLoopState } from './state'

const ALLOCATION_CAS_ATTEMPTS = 5
const ALLOCATION_RETRY_DELAY_MS = 1_000
const TEARDOWN_CAS_ATTEMPTS = 5
const TEARDOWN_RETRY_ROUNDS = 3
const TEARDOWN_RETRY_DELAY_MS = 500

async function runAllocatorForIndex(
  coordinator: ClusterCoordinator,
  indexName: string,
  nodes: NodeRegistration[],
  isActive: () => boolean,
  attempt = 0,
): Promise<void> {
  if (!isActive()) {
    return
  }

  const currentTable = await coordinator.getAllocation(indexName)
  if (currentTable === null || !isActive()) {
    return
  }

  const metadata = await getIndexMetadata(coordinator, indexName)
  if (metadata === null || !isActive()) {
    return
  }

  const result = allocate(
    nodes,
    currentTable,
    indexName,
    metadata.partitionCount,
    metadata.replicationFactor,
    metadata.constraints,
  )

  if (!isActive()) {
    return
  }

  if (await coordinator.putAllocation(indexName, result.table, currentTable.version)) {
    return
  }

  if (attempt + 1 < ALLOCATION_CAS_ATTEMPTS) {
    await runAllocatorForIndex(coordinator, indexName, nodes, isActive, attempt + 1)
    return
  }

  throw new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `Allocation for index '${indexName}' lost ${ALLOCATION_CAS_ATTEMPTS} compare-and-set attempts`,
    { indexName, attempts: ALLOCATION_CAS_ATTEMPTS },
  )
}

async function runAllocatorForAllIndexes(
  state: EventLoopState,
  coordinator: ClusterCoordinator,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
): Promise<void> {
  if (!isActive()) {
    return
  }

  const nodes = await coordinator.listNodes()
  if (nodes.length === 0 || !isActive()) {
    return
  }

  let anyIndexFailed = false
  for (const indexName of state.knownIndexes) {
    if (!isActive()) {
      return
    }
    try {
      await runAllocatorForIndex(coordinator, indexName, nodes, isActive)
    } catch (error) {
      anyIndexFailed = true
      if (onError !== undefined) {
        onError(indexName, error)
      }
    }
  }

  if (anyIndexFailed && isActive()) {
    scheduleDebouncedAllocation(state, coordinator, isActive, onError, ALLOCATION_RETRY_DELAY_MS)
  }
}

/**
 * Runs the allocator over every index the controller has recorded, once the cluster has been quiet for the debounce
 * window.
 *
 * A burst of node events collapses into one allocation run, because each call replaces the timer the previous one
 * set. An index whose write loses every compare-and-set attempt reaches `onError`, and a run that failed for any
 * index schedules a further run, so that a lost race resolves without waiting for an unrelated cluster event.
 *
 * @param state - The event loop state that holds the debounce timer and the known index names.
 * @param coordinator - The cluster coordinator this controller reads the topology from and writes allocations to.
 * @param isActive - Reports whether this node still holds the controller lease.
 * @param onError - Called with the index name and the error whenever one index's allocation fails.
 * @param debounceMs - How long the controller waits for further events before it runs the allocator.
 */
export function scheduleDebouncedAllocation(
  state: EventLoopState,
  coordinator: ClusterCoordinator,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
  debounceMs = 500,
): void {
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer)
  }

  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    runAllocatorForAllIndexes(state, coordinator, isActive, onError).catch(() => {
      if (isActive()) {
        scheduleDebouncedAllocation(state, coordinator, isActive, onError, ALLOCATION_RETRY_DELAY_MS)
      }
    })
  }, debounceMs)
  state.debounceTimer.unref?.()
}

async function handleSchemaCreated(
  indexName: string,
  coordinator: ClusterCoordinator,
  knownIndexes: Set<string>,
  isActive: () => boolean,
): Promise<void> {
  knownIndexes.add(indexName)

  if (!isActive()) {
    return
  }

  const metadata = await getIndexMetadata(coordinator, indexName)
  if (metadata === null || !isActive()) {
    return
  }

  const nodes = await coordinator.listNodes()
  if (nodes.length === 0 || !isActive()) {
    return
  }

  const storedTable = await coordinator.getAllocation(indexName)

  if (!isActive()) {
    return
  }

  const currentTable = storedTable !== null && storedTable.assignments.size === 0 ? null : storedTable

  const result = allocate(
    nodes,
    currentTable,
    indexName,
    metadata.partitionCount,
    metadata.replicationFactor,
    metadata.constraints,
  )

  if (!isActive()) {
    return
  }

  const expectedVersion = storedTable !== null ? storedTable.version : null
  if (await coordinator.putAllocation(indexName, result.table, expectedVersion)) {
    return
  }

  await runAllocatorForIndex(coordinator, indexName, nodes, isActive)
}

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
    tearDownAllocation(indexName, coordinator, state, isActive, round, onError).catch(error => {
      if (onError !== undefined) {
        onError(indexName, error)
      }
    })
  }, TEARDOWN_RETRY_DELAY_MS)
  timer.unref?.()
  state.teardownTimers.set(indexName, timer)
}

async function tearDownAllocation(
  indexName: string,
  coordinator: ClusterCoordinator,
  state: EventLoopState,
  isActive: () => boolean,
  round: number,
  onError?: (indexName: string, error: unknown) => void,
): Promise<void> {
  for (let attempt = 0; attempt < TEARDOWN_CAS_ATTEMPTS; attempt++) {
    if (!isActive()) {
      return
    }

    const currentTable = await coordinator.getAllocation(indexName)
    if (currentTable === null) {
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
      const written = await coordinator.putAllocation(indexName, emptyTable, currentTable.version)
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

/**
 * Brings a partition allocation into line with a schema that was created or dropped.
 *
 * A created index gets its first allocation, and a dropped index loses both its assignments and its allocation
 * entry. The controller retries a teardown whose write lost a compare-and-set, over a bounded number of rounds, and
 * it reports the failure through `onError` once those rounds run out, so that a dropped index never keeps an
 * allocation without anybody noticing.
 *
 * @param event - The schema change the coordinator reported.
 * @param coordinator - The cluster coordinator that stores schemas and allocation tables.
 * @param state - The event loop state that holds the known index names and the teardown timers.
 * @param isActive - Reports whether this node still holds the controller lease.
 * @param onError - Called with the index name and the error whenever a teardown finally fails.
 * @returns A promise that settles once the immediate work for this event has finished.
 */
export async function handleSchemaEvent(
  event: SchemaEvent,
  coordinator: ClusterCoordinator,
  state: EventLoopState,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
): Promise<void> {
  if (event.type === 'schema_created') {
    await handleSchemaCreated(event.indexName, coordinator, state.knownIndexes, isActive)
    return
  }

  if (event.type === 'schema_dropped') {
    state.knownIndexes.delete(event.indexName)
    await tearDownAllocation(event.indexName, coordinator, state, isActive, 0, onError)
  }
}
