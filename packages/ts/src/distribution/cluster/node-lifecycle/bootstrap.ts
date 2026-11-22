import { encode } from '@msgpack/msgpack'
import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import { decode } from '../../../serialization/msgpack'
import type { ClusterCoordinator } from '../../coordinator/types'
import { isRecord } from '../../payload-guards'
import type { BootstrapCompletePayload, NodeTransport, TransportMessage } from '../../transport/types'
import { ClusterMessageTypes, TransportError } from '../../transport/types'
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
 * address that its registration gives, because either may reach it. The caller must retry both where the result is
 * `false` and where the call throws, because each of them can pass once the controller or the coordinator recovers.
 *
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @param nodeId - This node's own id, which the controller compares with the assignment.
 * @param coordinator - The cluster coordinator, which names the controller and holds the assignment.
 * @param transport - The node transport this function sends the report over.
 * @returns True when the controller accepted the report, and false where no node holds the controller lease, the
 * table has no such partition, or the controller declined the report without a code.
 * @throws The coordinator's error where a read fails, the last transport error where the node couldn't reach the
 * controller at any target, and a {@link NarsilError} with the controller's code where it answered with an error.
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

  let sendFailure: unknown
  for (const target of await resolveControllerTargets(coordinator, controllerNodeId)) {
    let response: TransportMessage
    try {
      response = await transport.send(target, message)
    } catch (error) {
      sendFailure = error
      continue
    }
    return readCompletionAnswer(response, controllerNodeId)
  }
  throw sendFailure
}

function readCompletionAnswer(response: TransportMessage, controllerNodeId: string): boolean {
  let decoded: unknown
  try {
    decoded = decode(response.payload)
  } catch (_) {
    return false
  }
  if (!isRecord(decoded)) {
    return false
  }
  if (!response.type.endsWith('.error') && decoded.error !== true) {
    return decoded.accepted === true
  }
  if (typeof decoded.code !== 'string' || decoded.code === '') {
    return false
  }
  throw new NarsilError(
    decoded.code,
    typeof decoded.message === 'string'
      ? decoded.message
      : `Controller '${controllerNodeId}' refused the bootstrap completion report`,
    { controllerNodeId },
  )
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
 * Brings one partition into sync on this node, and tells the controller once the partition's primary holds its copy.
 *
 * The node retries the sync protocol with exponential backoff. A primary then reports completion, retrying that report
 * on the same schedule, and a replica reports nothing, because its primary admits it to the in-sync set once the
 * partition is `ACTIVE`. The primary rereads the partition before and between reports, because a controller that
 * committed the transition and lost the response would otherwise reject every retry, and the primary would report a
 * failure for a partition the cluster already treats as active.
 *
 * @param state - The bootstrap state, which names the partition and records whether a caller has abandoned it.
 * @param coordinator - The cluster coordinator that holds the allocation table and the controller lease.
 * @param transport - The node transport this function sends the completion report over.
 * @param nodeId - This node's own id, which the controller compares with the assignment.
 * @param bootstrapRetryBaseMs - The first backoff interval, which doubles on every further attempt.
 * @param bootstrapRetryMaxMs - The longest backoff interval the doubling reaches.
 * @param bootstrapMaxRetries - How many further attempts follow the first one.
 * @param onBootstrapPartition - Runs the sync protocol, and reports whether the partition is now in sync.
 * @param onError - Called with `NODE_BOOTSTRAP_FAILED` whenever a sync attempt throws or the last completion report
 * fails, unless the caller has abandoned the bootstrap. The `innerCode` detail carries the cause's code where the
 * cause has one.
 * @returns True once the partition is in sync, and for a primary once the allocation table records it, and false
 * otherwise.
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
      if (state.primaryNodeId !== nodeId || !(await partitionAwaitsBootstrapReport(state, coordinator))) {
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
    onError?.(bootstrapFailure(state, `Bootstrap sync failed for ${state.indexName}:${state.partitionId}`, error))
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
  let lastFailure: unknown
  for (let attempt = 0; attempt <= bootstrapMaxRetries; attempt++) {
    if (state.aborted) {
      return false
    }

    if (attempt > 0 && !(await partitionAwaitsBootstrapReport(state, coordinator))) {
      return true
    }

    try {
      if (await reportBootstrapComplete(state.indexName, state.partitionId, nodeId, coordinator, transport)) {
        return true
      }
      lastFailure = undefined
    } catch (error) {
      lastFailure = error
    }

    if (!(await partitionAwaitsBootstrapReport(state, coordinator))) {
      return true
    }

    if (attempt < bootstrapMaxRetries && !state.aborted) {
      const backoffMs = computeBackoffMs(bootstrapRetryBaseMs, bootstrapRetryMaxMs, attempt)
      await waitWithAbort(state, backoffMs)
    }
  }

  if (state.aborted) {
    return false
  }
  onError?.(
    bootstrapFailure(
      state,
      `Failed to report bootstrap completion for ${state.indexName}:${state.partitionId} after ${bootstrapMaxRetries + 1} attempts`,
      lastFailure,
    ),
  )

  return false
}

function bootstrapFailure(state: PartitionBootstrapState, message: string, failure: unknown): NarsilError {
  const details: Record<string, unknown> = { indexName: state.indexName, partitionId: state.partitionId }
  if (failure !== undefined) {
    details.cause = failure instanceof Error ? failure.message : String(failure)
  }
  if (failure instanceof NarsilError || failure instanceof TransportError) {
    details.innerCode = failure.code
  }
  return new NarsilError(ErrorCodes.NODE_BOOTSTRAP_FAILED, message, details)
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
