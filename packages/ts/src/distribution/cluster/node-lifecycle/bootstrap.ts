import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { ClusterCoordinator } from '../../coordinator/types'
import type { BootstrapCompletePayload, NodeTransport, TransportMessage } from '../../transport/types'
import { ClusterMessageTypes } from '../../transport/types'
import { CONTROLLER_LEASE_KEY } from '../controller/types'
import type { PartitionBootstrapState } from './types'

function computeBackoffMs(baseMs: number, maxMs: number, retryCount: number): number {
  const exponential = baseMs * 2 ** retryCount
  const capped = Math.min(exponential, maxMs)
  const jitter = capped * (0.5 + Math.random() * 0.5)
  return Math.floor(jitter)
}

async function resolvePrimaryTerm(
  indexName: string,
  partitionId: number,
  coordinator: ClusterCoordinator,
): Promise<number | null> {
  const table = await coordinator.getAllocation(indexName)
  if (table === null) {
    return null
  }
  const assignment = table.assignments.get(partitionId)
  if (assignment === undefined) {
    return null
  }
  return assignment.primaryTerm
}

async function resolveControllerTargets(coordinator: ClusterCoordinator, controllerNodeId: string): Promise<string[]> {
  const targets = [controllerNodeId]
  try {
    const nodes = await coordinator.listNodes()
    const registration = nodes.find(entry => entry.nodeId === controllerNodeId)
    if (registration !== undefined && registration.address.length > 0 && registration.address !== controllerNodeId) {
      targets.push(registration.address)
    }
  } catch (_) {
    return targets
  }
  return targets
}

/**
 * Tells the controller that this node has finished the sync protocol for a partition, and reports the answer.
 *
 * The node finds the controller through the controller lease, and it tries the controller's node id before the
 * address its registration gives, because either may reach it. A controller that cannot be reached, or that refuses
 * the report, leaves the result `false`, and the caller retries.
 *
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @param nodeId - This node's own id, which the controller compares with the assignment.
 * @param coordinator - The cluster coordinator, which names the controller and holds the assignment.
 * @param transport - The node transport this function sends the report over.
 * @returns True when the controller accepted the report, and false otherwise.
 */
export async function reportBootstrapComplete(
  indexName: string,
  partitionId: number,
  nodeId: string,
  coordinator: ClusterCoordinator,
  transport: NodeTransport,
): Promise<boolean> {
  const controllerNodeId = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId === null) {
    return false
  }

  const primaryTerm = await resolvePrimaryTerm(indexName, partitionId, coordinator)
  if (primaryTerm === null) {
    return false
  }

  const payload: BootstrapCompletePayload = {
    indexName,
    partitionId,
    nodeId,
    primaryTerm,
  }

  const message: TransportMessage = {
    type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
    sourceId: nodeId,
    requestId: generateId(),
    payload: encode(payload),
  }

  for (const target of await resolveControllerTargets(coordinator, controllerNodeId)) {
    try {
      const response = await transport.send(target, message)
      return isAcceptedResponse(response)
    } catch (_) {}
  }
  return false
}

function isAcceptedResponse(response: TransportMessage): boolean {
  try {
    const decoded = decode(response.payload)
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return false
    }
    return (decoded as Record<string, unknown>).accepted === true
  } catch (_) {
    return false
  }
}

async function partitionAwaitsBootstrapReport(
  state: PartitionBootstrapState,
  coordinator: ClusterCoordinator,
): Promise<boolean> {
  try {
    const table = await coordinator.getAllocation(state.indexName)
    const assignment = table?.assignments.get(state.partitionId)
    if (assignment === undefined) {
      return true
    }
    return assignment.state === 'INITIALISING'
  } catch (_) {
    return true
  }
}

/**
 * Brings one partition into sync on this node and tells the controller once it is ready.
 *
 * The node retries the sync protocol with exponential backoff, and it then reports completion, retrying that report
 * on the same schedule. It rereads the partition before and between reports, because a controller that committed
 * the transition and lost the response would otherwise reject every retry, and the node would report a failure for
 * a partition the cluster already treats as active.
 *
 * @param state - The bootstrap state, which names the partition and records whether a caller has abandoned it.
 * @param coordinator - The cluster coordinator that holds the allocation table and the controller lease.
 * @param transport - The node transport this function sends the completion report over.
 * @param nodeId - This node's own id, which the controller compares with the assignment.
 * @param bootstrapRetryBaseMs - The first backoff interval, which doubles on every further attempt.
 * @param bootstrapRetryMaxMs - The longest backoff interval the doubling reaches.
 * @param bootstrapMaxRetries - How many further attempts follow the first one.
 * @param onBootstrapPartition - Runs the sync protocol, and reports whether the partition is now in sync.
 * @param onError - Called with a coded error whenever a sync attempt or the whole report sequence fails.
 * @returns True once the partition is in sync and the allocation table records it, and false otherwise.
 */
export async function bootstrapPartition(
  state: PartitionBootstrapState,
  coordinator: ClusterCoordinator,
  transport: NodeTransport,
  nodeId: string,
  bootstrapRetryBaseMs: number,
  bootstrapRetryMaxMs: number,
  bootstrapMaxRetries: number,
  onBootstrapPartition: (indexName: string, partitionId: number, primaryNodeId: string) => Promise<boolean>,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  for (let attempt = 0; attempt <= bootstrapMaxRetries; attempt++) {
    if (state.aborted) {
      return false
    }

    const synced = await runBootstrapSyncAttempt(state, onBootstrapPartition, onError)
    if (state.aborted) {
      return false
    }

    if (synced) {
      if (!(await partitionAwaitsBootstrapReport(state, coordinator))) {
        return true
      }

      return retryReportBootstrapComplete(
        state,
        coordinator,
        transport,
        nodeId,
        bootstrapRetryBaseMs,
        bootstrapRetryMaxMs,
        bootstrapMaxRetries,
        onError,
      )
    }

    if (attempt < bootstrapMaxRetries) {
      const backoffMs = computeBackoffMs(bootstrapRetryBaseMs, bootstrapRetryMaxMs, attempt)
      await waitWithAbort(state, backoffMs)
    }
  }

  return false
}

async function runBootstrapSyncAttempt(
  state: PartitionBootstrapState,
  onBootstrapPartition: (indexName: string, partitionId: number, primaryNodeId: string) => Promise<boolean>,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  try {
    return await onBootstrapPartition(state.indexName, state.partitionId, state.primaryNodeId)
  } catch (error) {
    if (state.aborted) {
      return false
    }
    if (onError !== undefined) {
      const cause = error instanceof Error ? error.message : String(error)
      onError(
        new NarsilError(
          ErrorCodes.NODE_BOOTSTRAP_FAILED,
          `Bootstrap sync failed for ${state.indexName}:${state.partitionId}`,
          { indexName: state.indexName, partitionId: state.partitionId, cause },
        ),
      )
    }
    return false
  }
}

async function retryReportBootstrapComplete(
  state: PartitionBootstrapState,
  coordinator: ClusterCoordinator,
  transport: NodeTransport,
  nodeId: string,
  bootstrapRetryBaseMs: number,
  bootstrapRetryMaxMs: number,
  bootstrapMaxRetries: number,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  for (let attempt = 0; attempt <= bootstrapMaxRetries; attempt++) {
    if (state.aborted) {
      return false
    }

    if (attempt > 0 && !(await partitionAwaitsBootstrapReport(state, coordinator))) {
      return true
    }

    const accepted = await reportBootstrapComplete(state.indexName, state.partitionId, nodeId, coordinator, transport)

    if (accepted) {
      return true
    }

    if (!(await partitionAwaitsBootstrapReport(state, coordinator))) {
      return true
    }

    if (attempt < bootstrapMaxRetries && !state.aborted) {
      const backoffMs = computeBackoffMs(bootstrapRetryBaseMs, bootstrapRetryMaxMs, attempt)
      await waitWithAbort(state, backoffMs)
    }
  }

  if (onError !== undefined) {
    onError(
      new NarsilError(
        ErrorCodes.NODE_BOOTSTRAP_FAILED,
        `Failed to report bootstrap completion for ${state.indexName}:${state.partitionId} after ${bootstrapMaxRetries + 1} attempts`,
        { indexName: state.indexName, partitionId: state.partitionId },
      ),
    )
  }

  return false
}

function waitWithAbort(state: PartitionBootstrapState, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    if (state.aborted) {
      resolve()
      return
    }
    state.abortResolve = resolve
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      state.abortResolve = null
      resolve()
    }, ms)
  })
}

/**
 * Abandons a bootstrap, so that the node stops retrying a partition the controller has taken away from it.
 *
 * The abort clears any pending backoff at once, which means a bootstrap waiting between attempts returns without
 * serving out the rest of its interval.
 *
 * @param state - The bootstrap state to abandon.
 */
export function abortBootstrapState(state: PartitionBootstrapState): void {
  state.aborted = true
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  if (state.abortResolve !== null) {
    state.abortResolve()
    state.abortResolve = null
  }
}

/**
 * Builds the state one partition's bootstrap runs against.
 *
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @param primaryNodeId - The node this bootstrap syncs from.
 * @returns The fresh state, which no caller has aborted and which holds no pending backoff.
 */
export function createBootstrapState(
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
): PartitionBootstrapState {
  return {
    indexName,
    partitionId,
    primaryNodeId,
    retryCount: 0,
    retryTimer: null,
    aborted: false,
    abortResolve: null,
  }
}
