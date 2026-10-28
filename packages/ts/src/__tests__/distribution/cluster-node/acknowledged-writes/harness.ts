import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { decode, encode } from '@msgpack/msgpack'
import { createClusterNode } from '../../../../distribution'
import type { ClusterNode, ClusterNodeConfig } from '../../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, NodeRegistration } from '../../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../../distribution/transport'
import type { ListenHandler, NodeTransport, TransportMessage } from '../../../../distribution/transport/types'
import { TransportError } from '../../../../distribution/transport/types'

export const INDEX = 'ledger'
export const SCHEMA = { title: 'string', amount: 'number' } as const

const WAIT_INTERVAL_MS = 20
const PROBE_PAGE_LIMIT = 10_000

export type MessageRule = (target: string, message: TransportMessage) => boolean

export interface HeldMessages {
  count(): number
  release(): void
}

export interface FaultyTransport extends NodeTransport {
  dropWhen(rule: MessageRule): () => void
  holdWhen(rule: MessageRule): HeldMessages
  dropped(): TransportMessage[]
}

export function faultyTransport(inner: NodeTransport, nodeId: string): FaultyTransport {
  const rules = new Set<MessageRule>()
  const holds = new Set<{ rule: MessageRule; gate: Promise<void>; held: number }>()
  const droppedMessages: TransportMessage[] = []

  async function waitForRelease(target: string, message: TransportMessage): Promise<void> {
    for (const hold of holds) {
      if (hold.rule(target, message)) {
        hold.held += 1
        await hold.gate
      }
    }
  }

  function refuse(target: string, message: TransportMessage): void {
    for (const rule of rules) {
      if (rule(target, message)) {
        droppedMessages.push(message)
        throw new TransportError('TRANSPORT_PEER_UNAVAILABLE', `${nodeId} cannot reach ${target}`, { target })
      }
    }
  }

  return {
    async send(target, message) {
      await waitForRelease(target, message)
      refuse(target, message)
      return inner.send(target, message)
    },
    async stream(target, message, handler) {
      await waitForRelease(target, message)
      refuse(target, message)
      return inner.stream(target, message, handler)
    },
    listen(handler: ListenHandler) {
      return inner.listen(handler)
    },
    shutdown() {
      return inner.shutdown()
    },
    dropWhen(rule) {
      rules.add(rule)
      return () => rules.delete(rule)
    },
    holdWhen(rule) {
      let open: () => void = () => undefined
      const hold = { rule, gate: new Promise<void>(resolve => (open = resolve)), held: 0 }
      holds.add(hold)
      return {
        count: () => hold.held,
        release() {
          holds.delete(hold)
          open()
        },
      }
    },
    dropped() {
      return droppedMessages
    },
  }
}

export function onceFor(rule: MessageRule): MessageRule {
  let used = false
  return (target, message) => {
    if (used || !rule(target, message)) return false
    used = true
    return true
  }
}

export function ofType(type: string, target?: string): MessageRule {
  return (to, message) => message.type === type && (target === undefined || to === target)
}

export function entryForDocument(documentId: string): MessageRule {
  return (_to, message) => {
    if (message.type !== 'replication.entry') return false
    const payload = decode(message.payload) as { entry?: { documentId?: unknown } }
    return payload.entry?.documentId === documentId
  }
}

export interface FaultyCoordinator extends ClusterCoordinator {
  refuseRegistrationOf(nodeId: string): () => void
  cutOff(): () => void
}

export function faultyCoordinator(inner: ClusterCoordinator): FaultyCoordinator {
  const refused = new Set<string>()
  let unreachable = false
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'refuseRegistrationOf') {
        return (nodeId: string) => {
          refused.add(nodeId)
          return () => refused.delete(nodeId)
        }
      }
      if (property === 'cutOff') {
        return () => {
          unreachable = true
          return () => {
            unreachable = false
          }
        }
      }
      const value = Reflect.get(target, property, receiver)
      if (unreachable && typeof value === 'function' && property !== 'shutdown') {
        return async () => {
          throw new Error(`the coordinator is unreachable, so ${String(property)} failed`)
        }
      }
      if (property === 'registerNode') {
        return async (registration: NodeRegistration) => {
          if (refused.has(registration.nodeId)) {
            throw new Error(`the coordinator cannot reach ${registration.nodeId}`)
          }
          return target.registerNode(registration)
        }
      }
      return value
    },
  }) as FaultyCoordinator
}

export interface TestCluster {
  coordinator: FaultyCoordinator
  network: InMemoryNetwork
  nodes: Map<string, ClusterNode>
  transports: Map<string, FaultyTransport>
  directories: Map<string, string>
  probe: NodeTransport
  start(nodeId: string, options?: Partial<ClusterNodeConfig> & { durable?: boolean }): Promise<ClusterNode>
  stop(nodeId: string): Promise<void>
  node(nodeId: string): ClusterNode
  transport(nodeId: string): FaultyTransport
  dispose(): Promise<void>
}

export async function createTestCluster(): Promise<TestCluster> {
  const coordinator = faultyCoordinator(createInMemoryCoordinator())
  const network = createInMemoryNetwork()
  const nodes = new Map<string, ClusterNode>()
  const transports = new Map<string, FaultyTransport>()
  const directories = new Map<string, string>()
  const probe = createInMemoryTransport('copy-reader', network)
  const scratch = await mkdtemp(join(tmpdir(), 'narsil-acknowledged-writes-'))

  const cluster: TestCluster = {
    coordinator,
    network,
    nodes,
    transports,
    directories,
    probe,
    async start(nodeId, options = {}) {
      const { durable = true, ...config } = options
      const transport = faultyTransport(createInMemoryTransport(nodeId, network), nodeId)
      transports.set(nodeId, transport)
      let directory = directories.get(nodeId)
      if (durable && directory === undefined) {
        directory = join(scratch, nodeId)
        directories.set(nodeId, directory)
      }
      const node = await createClusterNode({
        coordinator,
        transport,
        address: nodeId,
        nodeId,
        roles: ['data', 'coordinator'],
        ...config,
        engine: {
          workers: { enabled: false },
          ...(durable && directory !== undefined ? { durability: { directory, mode: 'sync' } } : {}),
          ...config.engine,
        },
      })
      await node.start()
      nodes.set(nodeId, node)
      return node
    },
    async stop(nodeId) {
      const node = nodes.get(nodeId)
      nodes.delete(nodeId)
      await node?.shutdown()
      await transports.get(nodeId)?.shutdown()
      transports.delete(nodeId)
    },
    node(nodeId) {
      const node = nodes.get(nodeId)
      if (node === undefined) throw new Error(`${nodeId} is not running`)
      return node
    },
    transport(nodeId) {
      const transport = transports.get(nodeId)
      if (transport === undefined) throw new Error(`${nodeId} has no transport`)
      return transport
    },
    async dispose() {
      for (const nodeId of [...nodes.keys()]) {
        await cluster.stop(nodeId).catch(() => undefined)
      }
      await probe.shutdown()
      await coordinator.shutdown()
      await rm(scratch, { recursive: true, force: true })
    },
  }
  return cluster
}

export async function waitUntil<T>(
  description: string,
  check: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value !== null && value !== undefined && value !== false) return value
    } catch (error) {
      lastError = error
    }
    await sleep(WAIT_INTERVAL_MS)
  }
  const cause = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}${cause}`)
}

export async function publishedHeapLimitBytes(node: ClusterNode): Promise<number> {
  const registration = (await node.cluster.listNodes()).find(entry => entry.nodeId === node.nodeId)
  const heapLimitBytes = registration?.memory?.heapLimitBytes
  if (heapLimitBytes === undefined) throw new Error(`${node.nodeId} publishes no heap limit`)
  return heapLimitBytes
}

export function partitionAssignment(table: AllocationTable | null, partitionId = 0) {
  return table?.assignments.get(partitionId)
}

export async function waitForCopies(
  coordinator: ClusterCoordinator,
  primary: string | null,
  inSync: string[],
  timeoutMs?: number,
): Promise<AllocationTable> {
  return waitUntil(
    `${primary ?? 'any node'} to lead ${INDEX} with ${inSync.join(', ') || 'no replica'} in sync`,
    async () => {
      const table = await coordinator.getAllocation(INDEX)
      const assignment = partitionAssignment(table)
      if (assignment === undefined || assignment.state !== 'ACTIVE' || assignment.primary === null) return null
      if (primary !== null && assignment.primary !== primary) return null
      if (!inSync.every(nodeId => assignment.inSyncSet.includes(nodeId))) return null
      return table
    },
    timeoutMs,
  )
}

export async function readCopy(
  probe: NodeTransport,
  nodeId: string,
  partitionId = 0,
  indexName: string = INDEX,
): Promise<Map<string, Record<string, unknown>>> {
  const response = await probe.send(nodeId, {
    type: 'query.list',
    sourceId: 'copy-reader',
    requestId: `copy-read-${nodeId}-${Date.now()}-${Math.random()}`,
    payload: encode({
      indexName,
      partitionIds: [partitionId],
      cursor: null,
      limit: PROBE_PAGE_LIMIT,
      filters: null,
      sort: null,
      fields: null,
    }),
  })
  const payload = decode(response.payload) as {
    entries?: Array<{ docId: string; document: Record<string, unknown> }>
    hasMore?: boolean
    message?: string
  }
  if (response.type !== 'query.list_result' || payload.entries === undefined) {
    throw new Error(`${nodeId} answered a copy read with ${response.type}: ${payload.message ?? ''}`)
  }
  if (payload.hasMore === true) throw new Error(`${nodeId} holds more than ${PROBE_PAGE_LIMIT} documents`)
  const documents = new Map<string, Record<string, unknown>>()
  for (const entry of payload.entries) {
    const { id: _id, ...fields } = entry.document
    documents.set(entry.docId, fields)
  }
  return documents
}

export async function describeCluster(cluster: TestCluster): Promise<string> {
  const table = await cluster.coordinator.getAllocation(INDEX)
  const lines: string[] = []
  for (const [partitionId, assignment] of table?.assignments ?? []) {
    lines.push(
      `partition ${partitionId}: ${assignment.state}, primary ${assignment.primary}, term ${assignment.primaryTerm}, replicas [${assignment.replicas.join(', ')}], in sync [${assignment.inSyncSet.join(', ')}], commit point ${assignment.commitPoint}`,
    )
    for (const holder of new Set([assignment.primary, ...assignment.replicas])) {
      if (holder === null) continue
      const copy = await readCopy(cluster.probe, holder, partitionId).catch((error: Error) => error)
      lines.push(
        copy instanceof Error ? `  ${holder}: ${copy.message}` : `  ${holder}: ${[...copy.keys()].sort().join(', ')}`,
      )
    }
  }
  return lines.join('\n')
}

export async function withClusterState<T>(cluster: TestCluster, waiting: Promise<T>): Promise<T> {
  try {
    return await waiting
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n${await describeCluster(cluster)}`)
  }
}

export type Outcome = { state: 'acknowledged' } | { state: 'refused'; code: unknown }

export async function outcomeOf(write: Promise<unknown>): Promise<Outcome> {
  try {
    await write
    return { state: 'acknowledged' }
  } catch (error) {
    return { state: 'refused', code: (error as { code?: unknown }).code }
  }
}
