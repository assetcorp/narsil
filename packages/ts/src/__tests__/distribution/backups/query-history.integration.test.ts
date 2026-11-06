import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { clusterNodeEngine } from '../../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator, NodeRole } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { NarsilError } from '../../../errors'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import { querySuggestions } from '../../../query-suggestions'

const KEY = new Uint8Array(32).fill(23)
const SOURCE = 'catalogue'
const PHRASE = 'trail shoes'
const BANNED = 'cheap knockoffs'
const KEY_PREFIX = 'clusters/catalogue'
const SETTING = { enabled: true, fields: ['title'], minPeople: 2, minResults: 1, schedule: 'off' }
const SETTLE_TIMEOUT_MS = 60_000

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof NarsilError) return error.code
    throw error
  }
  return 'no error'
}

async function historyDigestsUnder(directory: string, indexName: string): Promise<string[]> {
  const folder = join(directory, '_query-counts', indexName)
  const digests: string[] = []
  for (const item of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (!item.isFile() || !item.name.endsWith('.nrsl')) continue
    const path = join(item.parentPath, item.name)
    if (relative(folder, path) === 'build.nrsl') continue
    digests.push(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    )
  }
  return digests
}

async function manifestHistoryOf(storeDirectory: string, backupName: string): Promise<string[] | undefined> {
  const { readBackupManifest, openBackupStore } = await import('../../../distribution/backups/store')
  const store = openBackupStore({
    store: createFilesystemPersistence({ directory: storeDirectory }),
    keyPrefix: KEY_PREFIX,
  })
  return (await readBackupManifest(store, backupName)).queryHistory?.map(file => file.sha256)
}

describe('cluster backups that hold popular query suggestion history', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const nodes: ClusterNode[] = []
  const transports: NodeTransport[] = []
  let scratch = ''
  let storeDirectory = ''
  let controller: ClusterNode

  async function startNode(nodeId: string, roles: NodeRole[]): Promise<ClusterNode> {
    const transport = createInMemoryTransport(nodeId, network)
    const node = await createClusterNode({
      coordinator,
      transport,
      address: nodeId,
      nodeId,
      roles,
      backups: { store: createFilesystemPersistence({ directory: storeDirectory }), keyPrefix: KEY_PREFIX },
      engine: {
        querySuggestions: { key: KEY },
        workers: { enabled: false },
        durability: { directory: join(scratch, nodeId), mode: 'sync' },
      },
    })
    await node.start()
    nodes.push(node)
    transports.push(transport)
    return node
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'narsil-history-nodes-'))
    storeDirectory = await mkdtemp(join(tmpdir(), 'narsil-history-store-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controller = await startNode('node-a', ['data', 'coordinator', 'controller'])
    await controller.createIndex(SOURCE, { schema: { title: 'string' } }, { partitionCount: 1, replicationFactor: 0 })
    await controller.insert(SOURCE, { title: `${PHRASE} for wet ground` }, 'shoe-1')
    const onController = querySuggestions(clusterNodeEngine(controller))
    await onController.updateSetting(SOURCE, SETTING)
    await onController.updateBans(SOURCE, [BANNED])
    for (const person of ['person-1', 'person-2']) {
      await onController.recordQuery(SOURCE, { query: PHRASE, person, group: 'alpha' })
    }
    const counter = await startNode('node-b', ['coordinator'])
    const onCounter = querySuggestions(clusterNodeEngine(counter))
    for (const person of ['person-3', 'person-4']) {
      expect(await onCounter.recordQuery(SOURCE, { query: PHRASE, person, group: 'beta' })).toEqual({
        recorded: true,
        outcome: 'recorded',
      })
    }
    await controller.cluster.createBackup(SOURCE, 'with-history', { queryHistory: true })
    await controller.cluster.createBackup(SOURCE, 'without-history')
  }, SETTLE_TIMEOUT_MS)

  afterAll(async () => {
    for (const node of nodes.reverse()) await node.shutdown().catch(() => undefined)
    for (const transport of transports) await transport.shutdown().catch(() => undefined)
    await coordinator.shutdown()
    await rm(scratch, { recursive: true, force: true })
    await rm(storeDirectory, { recursive: true, force: true })
  })

  it('stores every node history file only where the caller asks for it', async () => {
    const onDisk = [
      ...(await historyDigestsUnder(join(scratch, 'node-a'), SOURCE)),
      ...(await historyDigestsUnder(join(scratch, 'node-b'), SOURCE)),
    ].sort()
    expect(onDisk).toHaveLength(2)
    expect((await manifestHistoryOf(storeDirectory, 'with-history'))?.sort()).toEqual(onDisk)
    expect(await manifestHistoryOf(storeDirectory, 'without-history')).toBeUndefined()
  })

  it(
    'restores the setting, the bans, and the counts of both nodes under the new name',
    async () => {
      await controller.cluster.restoreBackup('with-history', { indexName: 'catalogue-restored' })
      const restored = querySuggestions(clusterNodeEngine(controller))
      expect((await restored.status('catalogue-restored')).setting?.enabled).toBe(true)
      expect(await restored.bans('catalogue-restored')).toEqual([BANNED])
      const entries = (await restored.preview('catalogue-restored')).entries
      expect(entries.sort((left, right) => (left.group < right.group ? -1 : 1))).toEqual([
        { group: 'alpha', query: PHRASE, count: 2 },
        { group: 'beta', query: PHRASE, count: 2 },
      ])

      await controller.cluster.restoreBackup('without-history', { indexName: 'catalogue-plain' })
      expect((await restored.status('catalogue-plain')).setting?.enabled).toBe(true)
      expect(await restored.bans('catalogue-plain')).toEqual([BANNED])
      expect((await restored.preview('catalogue-plain')).entries).toEqual([])
    },
    SETTLE_TIMEOUT_MS,
  )

  it(
    'creates no index from a backup whose history file was altered in the store',
    async () => {
      const [digest] = (await manifestHistoryOf(storeDirectory, 'with-history')) ?? []
      expect(digest).toBeDefined()
      const path = join(storeDirectory, KEY_PREFIX, 'files', digest ?? '')
      const bytes = await readFile(path)
      bytes[bytes.byteLength - 1] ^= 0xff
      await writeFile(path, bytes)
      expect(await codeOf(controller.cluster.restoreBackup('with-history', { indexName: 'catalogue-tampered' }))).toBe(
        'BACKUP_DAMAGED',
      )
      expect((await controller.listIndexes()).map(index => index.name)).not.toContain('catalogue-tampered')
      expect(await coordinator.getSchema('catalogue-tampered')).toBeNull()
    },
    SETTLE_TIMEOUT_MS,
  )
})
