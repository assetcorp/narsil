import type { AllocationTable, ClusterCoordinator } from '../coordinator/types'

function everyPartitionActive(table: AllocationTable | null, partitionCount: number): boolean {
  if (table === null || table.assignments.size < partitionCount) {
    return false
  }
  for (const assignment of table.assignments.values()) {
    if (assignment.state !== 'ACTIVE') {
      return false
    }
  }
  return true
}

async function allocationPossible(coordinator: ClusterCoordinator): Promise<boolean> {
  const nodes = await coordinator.listNodes()
  return nodes.some(node => node.roles.includes('controller')) && nodes.some(node => node.roles.includes('data'))
}

/**
 * Waits until the controller has brought every partition of an index into service, or until the deadline passes.
 *
 * The controller allocates the partitions of a new index from the event its schema publication raises, so a write
 * sent straight after the creation would otherwise reach a primary that has yet to create its copy. This function
 * follows the allocation watch until the table marks every partition `ACTIVE`. It returns at once where no
 * registered node carries the controller role or none carries the data role, because no node would allocate the
 * index, and it returns at once where the coordinator fails, because the index exists either way and the next
 * write reports the state the cluster is in.
 *
 * @param coordinator - The coordinator the controller writes the allocation table to.
 * @param indexName - The index that was created.
 * @param partitionCount - How many partitions the index metadata asked for.
 * @param timeoutMs - How many milliseconds to wait, where zero or less returns at once.
 * @returns A promise that settles once every partition is `ACTIVE`, or once the deadline passes.
 */
export async function waitForServingAllocation(
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionCount: number,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) {
    return
  }

  let settle: () => void = () => undefined
  const outcome = new Promise<void>(resolve => {
    settle = resolve
  })
  const deadline = setTimeout(settle, timeoutMs)
  deadline.unref?.()
  let unwatch: () => void = () => undefined

  try {
    unwatch = await coordinator.watchAllocation(event => {
      if (event.indexName === indexName && everyPartitionActive(event.table, partitionCount)) {
        settle()
      }
    })
    if (everyPartitionActive(await coordinator.getAllocation(indexName), partitionCount)) {
      return
    }
    if (!(await allocationPossible(coordinator))) {
      return
    }
    await outcome
  } catch (_) {
    return
  } finally {
    clearTimeout(deadline)
    unwatch()
  }
}
