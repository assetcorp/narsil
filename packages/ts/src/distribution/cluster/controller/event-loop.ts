import { decode } from '@msgpack/msgpack'
import type { ClusterCoordinator, NodeEvent, NodeRegistration, SchemaEvent } from '../../coordinator/types'
import { createInsyncConfirmMessage } from '../../replication/codec'
import { handleInsyncRemoval } from '../../replication/insync'
import type { InsyncRemovePayload, NodeTransport, TransportMessage } from '../../transport/types'
import { ClusterMessageTypes, ReplicationMessageTypes } from '../../transport/types'
import { allocate } from '../allocator/index'
import { getIndexMetadata } from '../index-metadata'
import { handleBootstrapCompleteMessage } from './bootstrap-handler'

export interface EventLoopState {
  unwatchNodes: (() => void) | null
  unwatchSchemas: (() => void) | null
  unwatchTransport: (() => void) | null
  knownIndexes: Set<string>
  debounceTimer: ReturnType<typeof setTimeout> | null
  insyncQueue: Promise<void>
}

export function createEventLoopState(initialIndexNames: string[]): EventLoopState {
  return {
    unwatchNodes: null,
    unwatchSchemas: null,
    unwatchTransport: null,
    knownIndexes: new Set(initialIndexNames),
    debounceTimer: null,
    insyncQueue: Promise.resolve(),
  }
}

export function clearEventLoopWatchers(state: EventLoopState): void {
  if (state.unwatchNodes !== null) {
    state.unwatchNodes()
    state.unwatchNodes = null
  }
  if (state.unwatchSchemas !== null) {
    state.unwatchSchemas()
    state.unwatchSchemas = null
  }
  if (state.unwatchTransport !== null) {
    state.unwatchTransport()
    state.unwatchTransport = null
  }
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

function validateInsyncRemovePayload(decoded: unknown): InsyncRemovePayload | null {
  if (!isRecord(decoded)) {
    return null
  }
  if (typeof decoded.indexName !== 'string') {
    return null
  }
  if (!isValidInteger(decoded.partitionId)) {
    return null
  }
  if (typeof decoded.replicaNodeId !== 'string') {
    return null
  }
  if (!isValidInteger(decoded.primaryTerm)) {
    return null
  }
  return {
    indexName: decoded.indexName,
    partitionId: decoded.partitionId,
    replicaNodeId: decoded.replicaNodeId,
    primaryTerm: decoded.primaryTerm,
  }
}

async function runAllocatorForIndex(
  coordinator: ClusterCoordinator,
  indexName: string,
  nodes: NodeRegistration[],
  isActive: () => boolean,
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

  await coordinator.putAllocation(indexName, result.table, currentTable.version)
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

function scheduleDebouncedAllocation(
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

  const currentTable = await coordinator.getAllocation(indexName)

  if (!isActive()) {
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

  const expectedVersion = currentTable !== null ? currentTable.version : null
  await coordinator.putAllocation(indexName, result.table, expectedVersion)
}

function handleSchemaDropped(indexName: string, knownIndexes: Set<string>): void {
  knownIndexes.delete(indexName)
}

async function handleSchemaEvent(
  event: SchemaEvent,
  coordinator: ClusterCoordinator,
  knownIndexes: Set<string>,
  isActive: () => boolean,
): Promise<void> {
  if (event.type === 'schema_created') {
    await handleSchemaCreated(event.indexName, coordinator, knownIndexes, isActive)
  } else if (event.type === 'schema_dropped') {
    handleSchemaDropped(event.indexName, knownIndexes)
  }
}

export async function startEventLoop(
  state: EventLoopState,
  coordinator: ClusterCoordinator,
  transport: NodeTransport,
  nodeId: string,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
): Promise<void> {
  clearEventLoopWatchers(state)

  const unwatchNodes = await coordinator.watchNodes((_event: NodeEvent) => {
    scheduleDebouncedAllocation(state, coordinator, isActive, onError)
  })
  state.unwatchNodes = unwatchNodes

  const unwatchSchemas = await coordinator.watchSchemas((event: SchemaEvent) => {
    handleSchemaEvent(event, coordinator, state.knownIndexes, isActive).catch(() => {
      /* Schema event handling failure is recoverable; next event retries */
    })
  })
  state.unwatchSchemas = unwatchSchemas

  const unwatchTransport = await transport.listen(
    (message: TransportMessage, respond: (response: TransportMessage) => void) => {
      if (!isActive()) {
        return
      }
      if (message.type === ReplicationMessageTypes.INSYNC_REMOVE) {
        handleInsyncRemoveMessage(state, message, respond, coordinator, nodeId)
      } else if (message.type === ClusterMessageTypes.BOOTSTRAP_COMPLETE) {
        handleBootstrapCompleteMessage(message, respond, coordinator, nodeId)
      }
    },
  )
  state.unwatchTransport = unwatchTransport
}

function handleInsyncRemoveMessage(
  state: EventLoopState,
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  coordinator: ClusterCoordinator,
  nodeId: string,
): void {
  let decoded: unknown
  try {
    decoded = decode(message.payload)
  } catch (_) {
    return
  }

  const payload = validateInsyncRemovePayload(decoded)
  if (payload === null) {
    return
  }

  state.insyncQueue = state.insyncQueue
    .then(async () => {
      const table = await coordinator.getAllocation(payload.indexName)
      if (table === null) {
        return
      }

      const assignment = table.assignments.get(payload.partitionId)
      if (assignment === undefined) {
        return
      }

      if (assignment.primary !== message.sourceId) {
        return
      }

      const confirmPayload = await handleInsyncRemoval(payload, coordinator)
      const response = createInsyncConfirmMessage(confirmPayload, nodeId, message.requestId)
      respond(response)
    })
    .catch(() => {
      /* Insync removal failure; the primary will retry or detect the stale state */
    })
}
