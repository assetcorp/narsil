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

    const accepted = await reportBootstrapComplete(state.indexName, state.partitionId, nodeId, coordinator, transport)

    if (accepted) {
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
