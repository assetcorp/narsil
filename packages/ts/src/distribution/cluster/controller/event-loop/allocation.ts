import { ErrorCodes, NarsilError } from '../../../../errors'
import type { AllocationTable, ClusterCoordinator, NodeRegistration, SchemaEvent } from '../../../coordinator/types'
import { allocate } from '../../allocator/index'
import { getIndexMetadata } from '../../index-metadata'
import type { EventLoopState } from './state'

const ALLOCATION_CAS_ATTEMPTS = 5

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
  coordinator: ClusterCoordinator,
  knownIndexes: Set<string>,
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

  for (const indexName of knownIndexes) {
    if (!isActive()) {
      return
    }
    try {
      await runAllocatorForIndex(coordinator, indexName, nodes, isActive)
    } catch (error) {
      if (onError !== undefined) {
        onError(indexName, error)
      }
    }
  }
}

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
    runAllocatorForAllIndexes(coordinator, state.knownIndexes, isActive, onError).catch(() => {
      /* Debounced allocation failure is recoverable; next event retries */
    })
  }, debounceMs)
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

const TEARDOWN_CAS_ATTEMPTS = 5

async function handleSchemaDropped(
  indexName: string,
  coordinator: ClusterCoordinator,
  knownIndexes: Set<string>,
  isActive: () => boolean,
): Promise<void> {
  knownIndexes.delete(indexName)

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
}

export async function handleSchemaEvent(
  event: SchemaEvent,
  coordinator: ClusterCoordinator,
  knownIndexes: Set<string>,
  isActive: () => boolean,
): Promise<void> {
  if (event.type === 'schema_created') {
    await handleSchemaCreated(event.indexName, coordinator, knownIndexes, isActive)
  } else if (event.type === 'schema_dropped') {
    await handleSchemaDropped(event.indexName, coordinator, knownIndexes, isActive)
  }
}
