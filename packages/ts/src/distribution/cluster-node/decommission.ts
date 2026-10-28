import type { DataNodeHandle } from '../cluster/node-lifecycle/types'
import type { ClusterCoordinator, NodeRegistration, PartitionAssignment } from '../coordinator/types'
import { DECOMMISSION_RECHECK_INTERVAL_MS } from './constants'
import type { ClusterNode } from './types'

export interface DecommissionDeps {
  nodeId: string
  coordinator: ClusterCoordinator
  registration: NodeRegistration
  lifecycle: Pick<DataNodeHandle, 'writeRegistration'>
  node: Pick<ClusterNode, 'shutdown'>
}

function holdsCopy(assignment: PartitionAssignment, nodeId: string): boolean {
  return (
    assignment.primary === nodeId ||
    assignment.replicas.includes(nodeId) ||
    assignment.removingReplicas?.includes(nodeId) === true
  )
}

async function anyAssignmentHolds(coordinator: ClusterCoordinator, nodeId: string): Promise<boolean> {
  for (const indexName of await coordinator.listSchemas()) {
    const table = await coordinator.getAllocation(indexName)
    if (table === null) continue
    for (const assignment of table.assignments.values()) {
      if (holdsCopy(assignment, nodeId)) return true
    }
  }
  return false
}

function waitForChange(signal: AbortSignal | undefined, onWake: (wake: () => void) => void): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(wake, DECOMMISSION_RECHECK_INTERVAL_MS)
    function wake(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', wake)
      resolve()
    }
    signal?.addEventListener('abort', wake, { once: true })
    onWake(wake)
  })
}

async function waitUntilNoAssignmentHolds(deps: DecommissionDeps, signal: AbortSignal | undefined): Promise<void> {
  let wakeOnChange: () => void = () => {}
  const unwatch = await deps.coordinator.watchAllocation(() => wakeOnChange())
  try {
    while (await anyAssignmentHolds(deps.coordinator, deps.nodeId)) {
      signal?.throwIfAborted()
      await waitForChange(signal, wake => {
        wakeOnChange = wake
      })
      signal?.throwIfAborted()
    }
  } finally {
    unwatch()
  }
}

export async function decommissionNode(deps: DecommissionDeps, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()
  deps.registration.draining = true
  try {
    await deps.lifecycle.writeRegistration()
    await waitUntilNoAssignmentHolds(deps, signal)
  } catch (error) {
    delete deps.registration.draining
    await deps.lifecycle.writeRegistration().catch(() => {})
    throw error
  }
  await deps.node.shutdown()
}
