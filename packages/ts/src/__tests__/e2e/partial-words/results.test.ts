import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { waitForSettledReplica } from '../../distribution/cluster-node/cluster-harness'
import { INDEX, LANGUAGE_NAME, registerWorkshopLanguage, SCHEMA, TITLE_WORDS, workshopCorpus } from './corpus'
import {
  createWorkshopIndex,
  expectEveryProbe,
  hitsOf,
  insertAll,
  NO_WORKERS,
  RESULT_LIMIT,
  searchOver,
  startWorkshopServer,
  WORKERS_BUILT,
  type WorkshopServer,
  waitForWorkerCopies,
  workerCopies,
} from './harness'
import { createOracle } from './oracle'

const CORPUS_SIZE = 1_200
const LEAST_MATCHES = 50_000

const servers: WorkshopServer[] = []

beforeAll(() => {
  registerWorkshopLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function started(config: Parameters<typeof startWorkshopServer>[0]): Promise<WorkshopServer> {
  const server = await startWorkshopServer(config)
  servers.push(server)
  return server
}

function retitled(id: string, at: number): { docId: string; document: { id: string; title: string; body: string } } {
  const title = [TITLE_WORDS[(at * 7) % TITLE_WORDS.length], TITLE_WORDS[(at * 13 + 5) % TITLE_WORDS.length]].join(' ')
  return { docId: id, document: { id, title, body: 'chair lamp' } }
}

async function rewrite(
  server: WorkshopServer,
  documents: readonly AnyDocument[],
  seed: number,
  idPrefix: string,
): Promise<AnyDocument[]> {
  const updates = documents
    .filter((_, at) => (at + seed) % 4 === 0)
    .map((document, at) => retitled(String(document.id), at + seed))
  expect((await server.client.updateBatch(INDEX, updates)).failed).toEqual([])
  const removed = documents.filter((_, at) => (at + seed) % 5 === 1).map(document => String(document.id))
  expect((await server.client.removeBatch(INDEX, removed)).failed).toEqual([])
  const additions = workshopCorpus(300, seed, idPrefix)
  await insertAll(server, additions)

  const current = new Map(documents.map(document => [String(document.id), document]))
  for (const { docId, document } of updates) current.set(docId, document)
  for (const id of removed) current.delete(id)
  for (const document of additions) current.set(String(document.id), document)
  return [...current.values()]
}

describe('a partial-word search sent over HTTP matches the independent oracle', () => {
  it('on the main thread, after updates, removals, and new inserts', async () => {
    const documents = workshopCorpus(CORPUS_SIZE, 41)
    const server = await started({ workers: NO_WORKERS })
    await createWorkshopIndex(server, documents)
    const search = searchOver(server.client)
    expect(await expectEveryProbe(search, createOracle(documents), 'loaded')).toBeGreaterThan(LEAST_MATCHES)
    const current = await rewrite(server, documents, 42, 'late')
    await expectEveryProbe(search, createOracle(current), 'rewritten')
  }, 180_000)

  it.skipIf(!WORKERS_BUILT)(
    'on worker copies that hold several frozen segments and a growing tail',
    async () => {
      const documents = workshopCorpus(CORPUS_SIZE, 43)
      const server = await started({ workers: workerCopies() })
      await createWorkshopIndex(server, documents.slice(0, 300))
      await waitForWorkerCopies(server)
      for (let from = 300; from < documents.length; from += 150) {
        await insertAll(server, documents.slice(from, from + 150))
      }
      await server.client.waitForWrites(INDEX)
      const search = searchOver(server.client)
      expect(await expectEveryProbe(search, createOracle(documents), 'workers')).toBeGreaterThan(LEAST_MATCHES)

      const current = await rewrite(server, documents, 48, 'rewritten')
      await server.client.waitForWrites(INDEX)
      await expectEveryProbe(search, createOracle(current), 'workers rewritten', 'ids')
    },
    180_000,
  )
})

describe('a partial-word search after the index leaves the server that built it', () => {
  let directory: string | null = null

  afterEach(async () => {
    if (directory !== null) await rm(directory, { recursive: true, force: true })
    directory = null
  })

  it('answers from the checkpoint and the inserts logged after it, once the server restarts', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-partial-words-'))
    const documents = workshopCorpus(CORPUS_SIZE, 44)
    const first = await startWorkshopServer({ workers: NO_WORKERS, durability: { directory } })
    await createWorkshopIndex(first, documents)
    const checkpointed = await rewrite(first, documents, 45, 'before')
    await first.client.checkpoint(INDEX)
    const late = workshopCorpus(200, 49, 'logged')
    await insertAll(first, late)
    await first.stop()

    const second = await started({ workers: NO_WORKERS, durability: { directory } })
    await expectEveryProbe(searchOver(second.client), createOracle([...checkpointed, ...late]), 'restarted')
  }, 180_000)

  it('matches the documents that survive updates and removals logged after the checkpoint, once the server restarts', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-partial-words-'))
    const documents = workshopCorpus(CORPUS_SIZE, 50)
    const first = await startWorkshopServer({ workers: NO_WORKERS, durability: { directory } })
    await createWorkshopIndex(first, documents)
    await first.client.checkpoint(INDEX)
    const logged = await rewrite(first, documents, 46, 'after')
    await first.stop()

    const second = await started({ workers: NO_WORKERS, durability: { directory } })
    await expectEveryProbe(searchOver(second.client), createOracle(logged), 'restarted', 'ids')
  }, 180_000)

  it('answers from a snapshot restored into another server', async () => {
    const documents = workshopCorpus(CORPUS_SIZE, 46)
    const source = await started({ workers: NO_WORKERS })
    await createWorkshopIndex(source, documents)
    const snapshot = await source.client.snapshot(INDEX)

    const target = await started({ workers: NO_WORKERS })
    const task = await target.client.restore(INDEX, snapshot)
    expect((await target.client.waitForTask(task.id)).status).toBe('succeeded')
    await expectEveryProbe(searchOver(target.client), createOracle(documents), 'restored')
  }, 180_000)

  it('answers through a cluster coordinator that routes the search to a data node', async () => {
    const coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    const transports = [createInMemoryTransport('data-a', network), createInMemoryTransport('router', network)]
    const nodes: ClusterNode[] = []
    try {
      const data = await createClusterNode({
        coordinator,
        transport: transports[0],
        address: 'data-a:9200',
        nodeId: 'data-a',
        roles: ['data'],
        engine: { workers: NO_WORKERS },
      })
      await data.start()
      nodes.push(data)
      const router = await createClusterNode({
        coordinator,
        transport: transports[1],
        address: 'router:9200',
        nodeId: 'router',
        roles: ['coordinator', 'controller'],
        engine: { workers: NO_WORKERS },
      })
      await router.start()
      nodes.push(router)

      await router.createIndex(
        INDEX,
        { schema: SCHEMA, language: LANGUAGE_NAME },
        { partitionCount: 1, replicationFactor: 0 },
      )
      await waitForSettledReplica(coordinator, INDEX, 'data-a')
      const documents = workshopCorpus(600, 47)
      expect((await router.insertBatch(INDEX, documents)).failed).toEqual([])

      const search = async (query: Omit<QueryParams, 'limit'>) =>
        hitsOf(await router.query(INDEX, { ...query, limit: RESULT_LIMIT }))
      expect(await expectEveryProbe(search, createOracle(documents), 'cluster')).toBeGreaterThan(0)
    } finally {
      for (const node of nodes) await node.shutdown()
      for (const transport of transports) await transport.shutdown()
      await coordinator.shutdown()
    }
  }, 180_000)
})
