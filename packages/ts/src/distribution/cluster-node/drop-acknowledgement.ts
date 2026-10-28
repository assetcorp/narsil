import { decode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import { getIndexMetadata } from '../cluster/index-metadata'
import { createPartitionStoresMessage, validatePartitionStoresResultPayload } from '../cluster/partition-stores'
import type { ClusterCoordinator } from '../coordinator/types'
import { DROP_ACKNOWLEDGE_POLL_INTERVAL_MS, MAX_DROP_ACKNOWLEDGE_WAIT_MS } from './constants'
import type { ClusterLocalEngine } from './local-engine'
import { resolveNodeTargets } from './node-messaging'
import type { ClusterNodeConfig } from './types'

export interface DropAcknowledgementDeps {
  config: ClusterNodeConfig
  nodeId: string
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
}

function pause(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, DROP_ACKNOWLEDGE_POLL_INTERVAL_MS))
}

function holdsLocalCopy(engine: ClusterLocalEngine, indexName: string, droppedUuid: string | null): boolean {
  if (!engine.listIndexes().some(index => index.name === indexName)) return false
  const localUuid = engine.indexUuidOf(indexName)
  return droppedUuid === null || localUuid === droppedUuid || localUuid === null || localUuid === undefined
}

async function nodeHoldsCopy(
  deps: DropAcknowledgementDeps,
  nodeId: string,
  indexName: string,
  droppedUuid: string | null,
): Promise<boolean> {
  if (nodeId === deps.nodeId) return holdsLocalCopy(deps.engine, indexName, droppedUuid)
  const message = createPartitionStoresMessage({ indexName }, deps.nodeId, generateId())
  for (const target of await resolveNodeTargets(deps.config, nodeId)) {
    let payload: Uint8Array
    try {
      payload = (await deps.config.transport.send(target, message)).payload
    } catch {
      continue
    }
    let answer: ReturnType<typeof validatePartitionStoresResultPayload>
    try {
      answer = validatePartitionStoresResultPayload(decode(payload))
    } catch {
      return true
    }
    if (answer === null || answer.indexName !== indexName) return true
    return droppedUuid === null ? answer.indexUuid !== null : answer.indexUuid === droppedUuid
  }
  return true
}

async function nodesHoldingCopies(
  deps: DropAcknowledgementDeps,
  indexName: string,
  droppedUuid: string | null,
): Promise<string[]> {
  const nodeIds = new Set([deps.nodeId])
  for (const node of await deps.coordinator.listNodes()) {
    if (node.roles.includes('data')) nodeIds.add(node.nodeId)
  }
  const ordered = [...nodeIds]
  const holding = await Promise.all(ordered.map(nodeId => nodeHoldsCopy(deps, nodeId, indexName, droppedUuid)))
  return ordered.filter((_, at) => holding[at])
}

export async function awaitDropAcknowledgement(
  deps: DropAcknowledgementDeps,
  indexName: string,
  droppedUuid: string | null,
): Promise<void> {
  const deadline = Date.now() + MAX_DROP_ACKNOWLEDGE_WAIT_MS
  for (;;) {
    const tableRemains = (await deps.coordinator.getAllocation(indexName)) !== null
    const holders = await nodesHoldingCopies(deps, indexName, droppedUuid)
    if (!tableRemains && holders.length === 0) return
    if (Date.now() >= deadline) {
      throw new NarsilError(
        ErrorCodes.QUERY_NODE_TIMEOUT,
        `Index '${indexName}' is dropped, but ${tableRemains ? 'its allocation table is still stored and ' : ''}${holders.length} node(s) still held a copy after ${MAX_DROP_ACKNOWLEDGE_WAIT_MS} ms, so a create under that name can fail until they finish`,
        { indexName, pendingNodeIds: holders, allocationPending: tableRemains },
      )
    }
    await pause()
  }
}

export async function awaitTornDownCopy(
  engine: ClusterLocalEngine,
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<void> {
  const deadline = Date.now() + MAX_DROP_ACKNOWLEDGE_WAIT_MS
  while (engine.listIndexes().some(index => index.name === indexName) && Date.now() < deadline) {
    if ((await getIndexMetadata(coordinator, indexName)) !== null) return
    await pause()
  }
}
