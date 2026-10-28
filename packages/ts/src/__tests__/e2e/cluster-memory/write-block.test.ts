import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type EtcdContainerHandle,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from '../../distribution/coordinator/etcd-integration/fixtures'
import { errorOf, type HttpReply, type NodeProcess, request, startNodeProcess, waitFor } from './harness'

const HEAP_MEGABYTES = 192
const NODE_IDS = ['node-1', 'node-2', 'node-3']
const HEAVY_INDEX = 'catalogue'
const SPARE_INDEX = 'ledger'
const FILL_BATCH_DOCUMENTS = 2_000
const FILL_MAX_BATCHES = 150
const WORDS_PER_BODY = 120
const VOCABULARY_WORDS = 20_000
const PACING_HEAP_FRACTION = 0.7
const SAMPLE_WAIT_MS = 1_200
const PROPAGATION_TIMEOUT_MS = 20_000
const RESUME_TIMEOUT_MS = 90_000
const KEPT_DOCUMENTS = 40
const REMOVE_BATCH_DOCUMENTS = 500

interface Furniture {
  title: string
  body: string
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const random = createRandom(79)
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

function inventedWord(): string {
  let word = 'zq'
  for (let letter = 0; letter < 6; letter++) {
    word += LETTERS[Math.floor(random() * LETTERS.length)]
  }
  return word
}

const VOCABULARY = Array.from({ length: VOCABULARY_WORDS }, inventedWord)

function furnitureNumber(serial: number): Furniture {
  const words: string[] = []
  for (let word = 0; word < WORDS_PER_BODY; word++) {
    words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)])
  }
  const kind = serial % 2 === 0 ? 'Oak chair' : 'Brass lamp'
  return { title: `${kind} ${serial}`, body: words.join(' ') }
}

function titledChair(document: Furniture): boolean {
  return document.title.toLowerCase().split(' ').includes('chair')
}

function chairsIn(oracle: Map<string, Furniture>): number {
  let chairs = 0
  for (const document of oracle.values()) if (titledChair(document)) chairs++
  return chairs
}

async function heapFractionOf(node: NodeProcess): Promise<number> {
  const reply = await request(node.base, 'GET', '/stats/memory')
  const figures = reply.body.process as { heapUsed?: unknown } | null
  const heapUsed = typeof figures?.heapUsed === 'number' ? figures.heapUsed : 0
  return heapUsed / node.heapLimitBytes
}

async function reportedFull(observer: NodeProcess, nodeId: string): Promise<boolean | null> {
  const reply = await request(observer.base, 'GET', '/cluster')
  const nodes = (reply.body.nodes ?? []) as Array<{ nodeId: string; memory: { full?: unknown } | null }>
  const entry = nodes.find(node => node.nodeId === nodeId)
  return typeof entry?.memory?.full === 'boolean' ? entry.memory.full : null
}

async function primaryOf(node: NodeProcess, indexName: string): Promise<string | null> {
  const reply = await request(node.base, 'GET', `/indexes/${indexName}/cluster`)
  const partitions = (reply.body.partitions ?? []) as Array<{ primary: string | null; state: string }>
  const active = partitions.find(partition => partition.state === 'ACTIVE')
  return active?.primary ?? null
}

describe('a three-process cluster on etcd refuses writes to the indexes of a node past its memory limit', () => {
  let container: EtcdContainerHandle | null = null
  const nodes: NodeProcess[] = []

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
    } else {
      await runDocker(['version'])
      container = await startEtcdContainer()
    }
    const keyPrefix = `_narsil_memory_block_${randomUUID()}`
    for (const nodeId of NODE_IDS) {
      nodes.push(
        await startNodeProcess({ nodeId, etcdEndpoint: container.endpoint, keyPrefix, heapMegabytes: HEAP_MEGABYTES }),
      )
    }
    await waitFor('every node to see the other two', PROPAGATION_TIMEOUT_MS, async () => {
      for (const node of nodes) {
        const reply = await request(node.base, 'GET', '/cluster')
        if (((reply.body.nodes ?? []) as unknown[]).length !== NODE_IDS.length) return false
      }
      return true
    })
  }, 180_000)

  afterAll(async () => {
    for (const node of nodes) {
      if (node.exited()) console.error(`${node.nodeId} exited early:\n${node.output()}`)
    }
    await Promise.all(nodes.map(node => node.stop()))
    await stopEtcdContainer(container?.name ?? null)
  }, 60_000)

  it('blocks inserts and updates, serves removes and searches, and accepts writes again once memory falls', async () => {
    const entry = nodes[0]
    async function createIndexWithPrimary(indexName: string): Promise<string> {
      const created = await request(entry.base, 'POST', '/indexes', {
        name: indexName,
        config: { schema: { title: 'string', body: 'string' } },
      })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      const found: { primary: string | null } = { primary: null }
      await waitFor(`${indexName} to have an active primary`, PROPAGATION_TIMEOUT_MS, async () => {
        found.primary = await primaryOf(entry, indexName)
        return found.primary !== null
      })
      if (found.primary === null) throw new Error(`${indexName} has no primary`)
      return found.primary
    }

    const fullNodeId = await createIndexWithPrimary(HEAVY_INDEX)
    const heavyIndex = HEAVY_INDEX
    const fullNode = nodes.find(node => node.nodeId === fullNodeId)
    const otherNode = nodes.find(node => node.nodeId !== fullNodeId)
    if (fullNode === undefined || otherNode === undefined) throw new Error('the cluster lost a node')

    const oracle = new Map<string, Furniture>()
    const spareOracle = new Map<string, Furniture>()
    let serial = 0
    let refusal: HttpReply | null = null
    for (let batch = 0; batch < FILL_MAX_BATCHES && refusal === null; batch++) {
      const documents: Array<Furniture & { id: string }> = []
      for (let count = 0; count < FILL_BATCH_DOCUMENTS; count++) {
        documents.push({ id: `item-${serial}`, ...furnitureNumber(serial) })
        serial++
      }
      const reply = await request(fullNode.base, 'POST', `/indexes/${heavyIndex}/documents/_batch`, { documents })
      if (reply.status === 429) {
        refusal = reply
        break
      }
      expect(reply.status, JSON.stringify(reply.body)).toBe(200)
      expect(reply.body.failed).toEqual([])
      for (const { id, ...document } of documents) oracle.set(id, document)
      expect(fullNode.exited(), fullNode.output()).toBe(false)
      if ((await heapFractionOf(fullNode)) > PACING_HEAP_FRACTION) await sleep(SAMPLE_WAIT_MS)
    }

    expect(refusal, `${fullNodeId} never refused a batch after ${oracle.size} documents`).not.toBeNull()
    if (refusal === null) return
    expect(errorOf(refusal).code).toBe('CLUSTER_WRITE_BLOCKED')
    expect(errorOf(refusal).details).toMatchObject({ indexName: heavyIndex, fullNodeIds: [fullNodeId] })
    expect(fullNode.exited(), fullNode.output()).toBe(false)
    console.log(`${fullNodeId} refused writes after ${oracle.size} documents`)

    await waitFor(`${otherNode.nodeId} to see ${fullNodeId} report full`, PROPAGATION_TIMEOUT_MS, async () => {
      return (await reportedFull(otherNode, fullNodeId)) === true
    })

    let probe = 0
    async function insertProbe(node: NodeProcess, indexName: string, into: Map<string, Furniture>): Promise<HttpReply> {
      const id = `probe-${probe++}`
      const document = furnitureNumber(serial++)
      const reply = await request(node.base, 'POST', `/indexes/${indexName}/documents`, { id, document })
      if (reply.status === 201) into.set(id, document)
      return reply
    }

    await waitFor(`${otherNode.nodeId} to refuse inserts`, PROPAGATION_TIMEOUT_MS, async () => {
      return (await insertProbe(otherNode, heavyIndex, oracle)).status === 429
    })

    const spareIndex = SPARE_INDEX
    expect(await createIndexWithPrimary(spareIndex)).not.toBe(fullNodeId)

    const refusedId = 'refused-1'
    const existingId = 'item-1'
    const existing = oracle.get(existingId)
    if (existing === undefined) throw new Error('the first batch was never stored')
    const replacement = { title: 'Oak chair replacement', body: 'zqreplaced' }
    const attempts: Array<[string, string, string, unknown]> = [
      [fullNode.base, 'POST', `/indexes/${heavyIndex}/documents`, { id: refusedId, document: replacement }],
      [otherNode.base, 'POST', `/indexes/${heavyIndex}/documents`, { id: refusedId, document: replacement }],
      [
        fullNode.base,
        'POST',
        `/indexes/${heavyIndex}/documents/_batch`,
        { documents: [{ id: refusedId, ...replacement }] },
      ],
      [otherNode.base, 'PATCH', `/indexes/${heavyIndex}/documents/${existingId}`, { document: replacement }],
      [otherNode.base, 'PUT', `/indexes/${heavyIndex}/documents/${existingId}`, { document: replacement }],
      [
        fullNode.base,
        'POST',
        `/indexes/${heavyIndex}/documents/_batch`,
        { action: 'update', updates: [{ docId: existingId, document: replacement }] },
      ],
    ]
    for (const [base, method, path, body] of attempts) {
      const reply = await request(base, method, path, body)
      expect(reply.status, `${method} ${path} on ${base}`).toBe(429)
      expect(errorOf(reply).code).toBe('CLUSTER_WRITE_BLOCKED')
      expect(errorOf(reply).details.fullNodeIds).toEqual([fullNodeId])
    }

    expect((await insertProbe(fullNode, spareIndex, spareOracle)).status).toBe(201)

    const chairs = await request(otherNode.base, 'POST', `/indexes/${heavyIndex}/search`, {
      term: 'chair',
      fields: ['title'],
      tolerance: 0,
      limit: 5,
    })
    expect(chairs.status).toBe(200)
    expect(chairs.body.count).toBe(chairsIn(oracle))
    const counted = await request(fullNode.base, 'GET', `/indexes/${heavyIndex}/count`)
    expect(counted.body.count).toBe(oracle.size)
    const stored = await request(otherNode.base, 'GET', `/indexes/${heavyIndex}/documents/${existingId}`)
    expect(stored.body).toMatchObject({ document: existing })
    expect((await request(fullNode.base, 'GET', `/indexes/${heavyIndex}/documents/${refusedId}`)).status).toBe(404)

    const singleRemoval = await request(otherNode.base, 'DELETE', `/indexes/${heavyIndex}/documents/${existingId}`)
    expect(singleRemoval.status).toBe(200)
    oracle.delete(existingId)
    const removable = [...oracle.keys()].slice(KEPT_DOCUMENTS)
    for (let start = 0; start < removable.length; start += REMOVE_BATCH_DOCUMENTS) {
      const docIds = removable.slice(start, start + REMOVE_BATCH_DOCUMENTS)
      const removal = await request(fullNode.base, 'POST', `/indexes/${heavyIndex}/documents/_batch`, {
        action: 'delete',
        docIds,
      })
      expect(removal.status, JSON.stringify(removal.body)).toBe(200)
      expect(removal.body.failed).toEqual([])
      for (const id of docIds) oracle.delete(id)
    }
    expect((await request(otherNode.base, 'GET', `/indexes/${heavyIndex}/count`)).body.count).toBe(oracle.size)

    const resumedAt = Date.now()
    await waitFor(`${fullNodeId} to accept inserts again`, RESUME_TIMEOUT_MS, async () => {
      const reply = await insertProbe(fullNode, heavyIndex, oracle)
      if (reply.status !== 201) expect(errorOf(reply).code).toBe('CLUSTER_WRITE_BLOCKED')
      return reply.status === 201
    })
    console.log(`${fullNodeId} accepted writes ${Date.now() - resumedAt} ms after the removes finished`)
    await waitFor(`${otherNode.nodeId} to accept inserts again`, PROPAGATION_TIMEOUT_MS, async () => {
      return (await insertProbe(otherNode, heavyIndex, oracle)).status === 201
    })
    expect(await reportedFull(otherNode, fullNodeId)).toBe(false)

    const keptId = [...oracle.keys()].find(id => id.startsWith('item-'))
    if (keptId === undefined) throw new Error('every filled document was removed')
    const updated = await request(otherNode.base, 'PATCH', `/indexes/${heavyIndex}/documents/${keptId}`, {
      document: replacement,
    })
    expect(updated.status, JSON.stringify(updated.body)).toBe(200)
    oracle.set(keptId, replacement)
    const batchAfter = await request(fullNode.base, 'POST', `/indexes/${heavyIndex}/documents/_batch`, {
      documents: [{ id: refusedId, ...replacement }],
    })
    expect(batchAfter.status, JSON.stringify(batchAfter.body)).toBe(200)
    oracle.set(refusedId, replacement)

    const finalChairs = await request(fullNode.base, 'POST', `/indexes/${heavyIndex}/search`, {
      term: 'chair',
      fields: ['title'],
      tolerance: 0,
      limit: 5,
    })
    expect(finalChairs.body.count).toBe(chairsIn(oracle))
    expect((await request(otherNode.base, 'GET', `/indexes/${heavyIndex}/count`)).body.count).toBe(oracle.size)
    expect((await request(otherNode.base, 'GET', `/indexes/${spareIndex}/count`)).body.count).toBe(spareOracle.size)
    const read = await request(otherNode.base, 'GET', `/indexes/${heavyIndex}/documents/${keptId}`)
    expect(read.body).toMatchObject({ document: replacement })
  }, 600_000)
})
