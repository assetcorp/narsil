import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { decode } from '@msgpack/msgpack'
import { createNarsilClient, type NarsilClient } from '../../../client'
import { createClusterNode } from '../../../distribution/cluster-node'
import { clusterNodeEngine } from '../../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import type { Narsil } from '../../../narsil'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import { createServer, type NarsilServer } from '../../../server'
import { ADMIN_TOKEN, type FeedClient, type FeedMessage, type OwnerHook, type Position } from './fixtures'

const BACKUP_KEY_PREFIX = 'clusters/harbour'
const WAIT_INTERVAL_MS = 50
const FEED_MESSAGE_WAIT_MS = 20_000

export const SYNC_PARTITION_COUNT = 2

export type Note = { title: string; body: string }

interface Entry {
  seqNo: number
  operation: 'INDEX' | 'DELETE'
  documentId: string
  document: Uint8Array | null
}

interface RunningNode {
  node: ClusterNode
  transport: NodeTransport
}

export interface SyncCluster {
  coordinator: ClusterCoordinator
  network: InMemoryNetwork
  admin: NarsilClient
  node(nodeId: string): ClusterNode
  start(
    nodeId: string,
    roles: Array<'data' | 'coordinator' | 'controller'>,
    coordinator?: ClusterCoordinator,
  ): Promise<ClusterNode>
  stop(nodeId: string): Promise<void>
  serve(nodeId: string, owners: OwnerHook, feed?: 'sync' | 'changes'): Promise<string>
  dispose(): Promise<void>
}

export async function waitFor<T>(
  description: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
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

export function activeTable(coordinator: ClusterCoordinator, indexName: string): Promise<AllocationTable> {
  return waitFor(`${indexName} to have an active primary on every partition`, async () => {
    const table = await coordinator.getAllocation(indexName)
    if (table === null || table.generation !== undefined || table.assignments.size === 0) return null
    const ready = [...table.assignments.values()].every(
      assignment => assignment.state === 'ACTIVE' && assignment.primary !== null && assignment.inSyncSet.length > 0,
    )
    return ready ? table : null
  })
}

export async function startSyncCluster(options: { backups: boolean; nodeLeftDelayMs?: number }): Promise<SyncCluster> {
  const scratch = await mkdtemp(join(tmpdir(), 'narsil-cluster-sync-'))
  const storeDirectory = join(scratch, 'backup-store')
  const coordinator = createInMemoryCoordinator()
  const network = createInMemoryNetwork()
  const running = new Map<string, RunningNode>()
  const servers: NarsilServer[] = []
  let admin: NarsilClient | null = null

  const cluster: SyncCluster = {
    coordinator,
    network,
    get admin() {
      if (admin === null) throw new Error('No node serves HTTP yet')
      return admin
    },
    node(nodeId) {
      const found = running.get(nodeId)
      if (found === undefined) throw new Error(`${nodeId} is not running`)
      return found.node
    },
    async start(nodeId, roles, seenCoordinator = coordinator) {
      const transport = createInMemoryTransport(nodeId, network)
      const node = await createClusterNode({
        coordinator: seenCoordinator,
        transport,
        address: `${nodeId}:9200`,
        nodeId,
        roles,
        ...(options.backups
          ? {
              backups: {
                store: createFilesystemPersistence({ directory: storeDirectory }),
                keyPrefix: BACKUP_KEY_PREFIX,
              },
            }
          : {}),
        ...(options.nodeLeftDelayMs === undefined ? {} : { controller: { nodeLeftDelayMs: options.nodeLeftDelayMs } }),
        engine: { workers: { enabled: false }, durability: { directory: join(scratch, nodeId), mode: 'sync' } },
      })
      await node.start()
      running.set(nodeId, { node, transport })
      return node
    },
    async stop(nodeId) {
      const found = running.get(nodeId)
      running.delete(nodeId)
      await found?.node.shutdown()
      await found?.transport.shutdown()
    },
    async serve(nodeId, owners, feed = 'sync') {
      const node = cluster.node(nodeId)
      const engine: Narsil = clusterNodeEngine(node, {
        createIndex: { partitionCount: SYNC_PARTITION_COUNT, replicationFactor: 1 },
      })
      const server = createServer(engine, {
        host: '127.0.0.1',
        port: 0,
        cluster: node.cluster,
        [feed]: true,
        onRequest: ctx => owners.hook(ctx),
      })
      await server.listen()
      servers.push(server)
      const base = `http://127.0.0.1:${server.listeningPort}`
      admin ??= createNarsilClient({ url: base, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })
      return base
    },
    async dispose() {
      for (const server of servers.splice(0)) await server.close().catch(() => undefined)
      for (const nodeId of [...running.keys()].reverse()) await cluster.stop(nodeId).catch(() => undefined)
      await coordinator.shutdown()
      await rm(scratch, { recursive: true, force: true })
    },
  }
  return cluster
}

export function note(at: number): Note {
  return { title: `note ${at}`, body: `body of note ${at} about ${at % 2 === 0 ? 'ferries' : 'tugs'}` }
}

export async function documentsOf(engine: Narsil, index: string): Promise<Map<string, Note>> {
  const held = new Map<string, Note>()
  let cursor: string | undefined
  for (;;) {
    const page = await engine.listDocuments(index, { limit: 500, ...(cursor === undefined ? {} : { cursor }) })
    for (const item of page.documents) {
      const { title, body } = item.document as unknown as Note
      held.set(item.id, { title, body })
    }
    if (page.cursor === null) return held
    cursor = page.cursor
  }
}

async function applyEntry(device: Narsil, index: string, entry: Entry): Promise<void> {
  if (entry.operation === 'DELETE') {
    if (await device.has(index, entry.documentId)) await device.remove(index, entry.documentId)
    return
  }
  const { title, body } = decode(entry.document ?? new Uint8Array()) as Note
  if (await device.has(index, entry.documentId)) await device.update(index, entry.documentId, { title, body })
  else await device.insert(index, { title, body }, entry.documentId)
}

export function positionMap(positions: Position[]): Map<number, number> {
  return new Map(positions.map(position => [position.partitionId, position.seqNo]))
}

let checkpointIds = 0

export async function catchUp(feed: FeedClient, device: Narsil, index: string, reached: Map<number, number>) {
  const id = ++checkpointIds
  feed.send({ type: 'checkpoint', id })
  let heads: Map<number, number> | null = null
  const covered = (target: Map<number, number>): boolean =>
    [...target].every(([partitionId, head]) => (reached.get(partitionId) ?? 0) >= head)
  while (heads === null || !covered(heads)) {
    const message: FeedMessage = await feed.nextAny(FEED_MESSAGE_WAIT_MS)
    if (message.type === 'resync') throw new Error(`The feed asked for a resync: ${String(message.reason)}`)
    if (message.type === 'checkpoint' && message.id === id) heads = positionMap(message.heads as Position[])
    if (message.type !== 'entries') continue
    const partitionId = message.partitionId as number
    for (const entry of message.entries as Entry[]) {
      const previous = reached.get(partitionId) ?? 0
      if (entry.seqNo <= previous) throw new Error(`Partition ${partitionId} sent ${entry.seqNo} after ${previous}`)
      await applyEntry(device, index, entry)
      reached.set(partitionId, entry.seqNo)
    }
    feed.send({ type: 'ack', positions: [...reached].map(([at, seqNo]) => ({ partitionId: at, seqNo })) })
  }
}
