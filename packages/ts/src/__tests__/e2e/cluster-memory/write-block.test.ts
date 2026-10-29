import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type EtcdContainerHandle,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from '../../distribution/coordinator/etcd-integration/fixtures'
import {
  errorOf,
  expectEveryDocumentReadsBack,
  type HttpReply,
  isServerMemoryRefusal,
  type NodeProcess,
  request,
  startNodeProcess,
  waitFor,
} from './harness'

const HEAP_MEGABYTES = 192
const NODE_IDS = ['node-1', 'node-2', 'node-3']
const HEAVY_INDEX = 'catalogue'
const SPARE_INDEX = 'ledger'
const FILL_SEND_BUDGET_HEAP_LIMITS = 3
const WORDS_PER_BODY = 120
const VOCABULARY_WORDS = 20_000
const PACING_HEAP_FRACTION = 0.7
const SAMPLE_WAIT_MS = 1_200
const PROPAGATION_TIMEOUT_MS = 20_000
const RESUME_TIMEOUT_MS = 90_000
const KEPT_DOCUMENTS = 40
const REMOVE_BATCH_DOCUMENTS = 500
const SMALL_REMOVE_DOCUMENTS = 10
const LARGE_TEXT_CHARACTERS = 15_000_000
const LARGE_BATCH_DOCUMENTS = 5
const LARGE_IMPORT_LINE_CHARACTERS = 3_900_000
const FILL_SHAPES = [
  { name: '100-document batches', batchDocuments: 100 },
  { name: '2,000-document batches', batchDocuments: 2_000 },
]

interface Furniture {
  title: string
  body: string
}

interface BatchFailure {
  docId: string
  error: { code: string; details?: Record<string, unknown> }
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

async function importLines(base: string, indexName: string, lines: string[]): Promise<HttpReply> {
  const response = await fetch(`${base}/indexes/${indexName}/documents/_import`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: `${lines.join('\n')}\n`,
  })
  const text = await response.text()
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {}
  return {
    status: response.status,
    body: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
  }
}

function expectNodeMemoryFull(reply: HttpReply, fullNodeId: string, attempt: string): void {
  expect(reply.status, `${attempt}: ${JSON.stringify(reply.body).slice(0, 500)}`).toBe(429)
  expect(errorOf(reply).code, attempt).toBe('CLUSTER_WRITE_BLOCKED')
  expect(errorOf(reply).details, attempt).toMatchObject({ reason: 'node_memory_full', fullNodeIds: [fullNodeId] })
}

describe('a three-process cluster on etcd refuses writes to the indexes of a node past its memory limit', () => {
  let container: EtcdContainerHandle | null = null
  let nodes: NodeProcess[] = []

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
    } else {
      await runDocker(['version'])
      container = await startEtcdContainer()
    }
  }, 180_000)

  afterEach(async () => {
    for (const node of nodes) {
      if (node.exited()) console.error(`${node.nodeId} exited early:\n${node.output()}`)
    }
    await Promise.all(nodes.map(node => node.stop()))
    nodes = []
  }, 60_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
  }, 60_000)

  async function startCluster(): Promise<NodeProcess[]> {
    if (container === null) throw new Error('etcd never started')
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
    return nodes
  }

  it.each(
    FILL_SHAPES,
  )('reaches full under $name, blocks inserts and updates on every node, serves removes, and resumes once memory falls', async ({
    batchDocuments,
  }) => {
    const cluster = await startCluster()
    const entry = cluster[0]
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
    const fullNode = cluster.find(node => node.nodeId === fullNodeId)
    const otherNode = cluster.find(node => node.nodeId !== fullNodeId)
    if (fullNode === undefined || otherNode === undefined) throw new Error('the cluster lost a node')

    const oracle = new Map<string, Furniture>()
    const spareOracle = new Map<string, Furniture>()
    let serial = 0
    let documentRefusals = 0
    let serverRefusals = 0
    let full = false
    let sentBytes = 0
    const sendBudgetBytes = fullNode.heapLimitBytes * FILL_SEND_BUDGET_HEAP_LIMITS
    while (!full && sentBytes < sendBudgetBytes) {
      const documents: Array<Furniture & { id: string }> = []
      for (let count = 0; count < batchDocuments; count++) {
        documents.push({ id: `item-${serial}`, ...furnitureNumber(serial) })
        serial++
      }
      sentBytes += JSON.stringify({ documents }).length
      const reply = await request(fullNode.base, 'POST', `/indexes/${HEAVY_INDEX}/documents/_batch`, { documents })
      expect([200, 429], JSON.stringify(reply.body).slice(0, 500)).toContain(reply.status)
      if (reply.status === 429) {
        if (isServerMemoryRefusal(reply)) {
          serverRefusals++
        } else {
          expectNodeMemoryFull(reply, fullNodeId, 'a fill batch')
          full = true
        }
      } else {
        const failed = reply.body.failed as BatchFailure[]
        for (const failure of failed) {
          expect(failure.error.code, JSON.stringify(failure)).toBe('CLUSTER_WRITE_BLOCKED')
          expect(failure.error.details?.reason).toBe('write_would_fill_memory')
        }
        documentRefusals += failed.length
        const byId = new Map(documents.map(({ id, ...document }) => [id, document]))
        for (const docId of reply.body.succeeded as string[]) {
          const document = byId.get(docId)
          if (document === undefined) throw new Error(`the node acknowledged ${docId}, which the batch never held`)
          oracle.set(docId, document)
        }
      }
      expect(fullNode.exited(), fullNode.output()).toBe(false)
      full ||= (await reportedFull(fullNode, fullNodeId)) === true
      if (!full && (await heapFractionOf(fullNode)) > PACING_HEAP_FRACTION) await sleep(SAMPLE_WAIT_MS)
    }

    expect(
      full,
      `${fullNodeId} never reported full after ${oracle.size} documents and ${sentBytes} bytes sent, ` +
        `${FILL_SEND_BUDGET_HEAP_LIMITS} times its heap limit`,
    ).toBe(true)
    console.log(
      `${fullNodeId} reported full after ${oracle.size} documents, with ${documentRefusals} documents and ` +
        `${serverRefusals} batches refused before it`,
    )

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

    for (const node of cluster) {
      await waitFor(`${node.nodeId} to refuse inserts`, PROPAGATION_TIMEOUT_MS, async () => {
        const reply = await insertProbe(node, HEAVY_INDEX, oracle)
        if (reply.status === 201) return false
        expectNodeMemoryFull(reply, fullNodeId, `an insert on ${node.nodeId}`)
        return true
      })
    }

    expect(await createIndexWithPrimary(SPARE_INDEX)).not.toBe(fullNodeId)

    const refusedId = 'refused-1'
    const existingId = 'item-1'
    const existing = oracle.get(existingId)
    if (existing === undefined) throw new Error('the first batch was never stored')
    const replacement = { title: 'Oak chair replacement', body: 'zqreplaced' }
    const attempts: Array<[NodeProcess, string, string, unknown]> = [
      [fullNode, 'POST', `/indexes/${HEAVY_INDEX}/documents`, { id: refusedId, document: replacement }],
      [otherNode, 'POST', `/indexes/${HEAVY_INDEX}/documents`, { id: refusedId, document: replacement }],
      [
        fullNode,
        'POST',
        `/indexes/${HEAVY_INDEX}/documents/_batch`,
        { documents: [{ id: refusedId, ...replacement }] },
      ],
      [otherNode, 'PATCH', `/indexes/${HEAVY_INDEX}/documents/${existingId}`, { document: replacement }],
      [otherNode, 'PUT', `/indexes/${HEAVY_INDEX}/documents/${existingId}`, { document: replacement }],
      [
        fullNode,
        'POST',
        `/indexes/${HEAVY_INDEX}/documents/_batch`,
        { action: 'update', updates: [{ docId: existingId, document: replacement }] },
      ],
    ]
    for (const [node, method, path, body] of attempts) {
      expectNodeMemoryFull(
        await request(node.base, method, path, body),
        fullNodeId,
        `${method} ${path} on ${node.nodeId}`,
      )
    }

    const largeText = 'zq'.repeat(LARGE_TEXT_CHARACTERS / 2)
    const largeDocument = { title: 'Oak chair large', body: largeText }
    const largeAttempts: Array<[string, string, unknown]> = [
      ['POST', `/indexes/${HEAVY_INDEX}/documents`, { id: refusedId, document: largeDocument }],
      ['PUT', `/indexes/${HEAVY_INDEX}/documents/${existingId}`, { document: largeDocument }],
      ['PATCH', `/indexes/${HEAVY_INDEX}/documents/${existingId}`, { document: largeDocument }],
    ]
    for (const [method, path, body] of largeAttempts) {
      expectNodeMemoryFull(await request(fullNode.base, method, path, body), fullNodeId, `a large ${method} ${path}`)
    }
    const largeBatch = await request(fullNode.base, 'POST', `/indexes/${HEAVY_INDEX}/documents/_batch`, {
      documents: Array.from({ length: LARGE_BATCH_DOCUMENTS }, (_, index) => ({
        id: `large-${index}`,
        title: 'Brass lamp large',
        body: 'zq'.repeat(LARGE_TEXT_CHARACTERS / LARGE_BATCH_DOCUMENTS / 2),
      })),
    })
    expect(largeBatch.status, JSON.stringify(largeBatch.body).slice(0, 500)).toBe(429)
    expect(errorOf(largeBatch).code).toBe('TOO_MANY_REQUESTS')
    expect(errorOf(largeBatch).details.reason).toBe('parse_would_fill_memory')
    const largeImport = await importLines(fullNode.base, HEAVY_INDEX, [
      JSON.stringify({
        id: refusedId,
        title: 'Oak chair imported',
        body: 'zq'.repeat(LARGE_IMPORT_LINE_CHARACTERS / 2),
      }),
    ])
    if (largeImport.status === 200) {
      expect(largeImport.body).toMatchObject({ indexed: 0, failed: 1 })
      const [importError] = largeImport.body.errors as BatchFailure['error'][]
      expect(importError).toMatchObject({ code: 'CLUSTER_WRITE_BLOCKED', details: { reason: 'node_memory_full' } })
    } else {
      expectNodeMemoryFull(largeImport, fullNodeId, 'a large import')
    }

    expect((await insertProbe(fullNode, SPARE_INDEX, spareOracle)).status).toBe(201)

    const chairs = await request(otherNode.base, 'POST', `/indexes/${HEAVY_INDEX}/search`, {
      term: 'chair',
      fields: ['title'],
      tolerance: 0,
      limit: 5,
    })
    expect(chairs.status).toBe(200)
    expect(chairs.body.count).toBe(chairsIn(oracle))
    const counted = await request(fullNode.base, 'GET', `/indexes/${HEAVY_INDEX}/count`)
    expect(counted.body.count).toBe(oracle.size)
    await expectEveryDocumentReadsBack(otherNode.base, HEAVY_INDEX, oracle)
    expect((await request(fullNode.base, 'GET', `/indexes/${HEAVY_INDEX}/documents/${refusedId}`)).status).toBe(404)

    const smallRemoval = [...oracle.keys()].slice(-SMALL_REMOVE_DOCUMENTS)
    const smallRemovalReply = await request(fullNode.base, 'POST', `/indexes/${HEAVY_INDEX}/documents/_batch`, {
      action: 'delete',
      docIds: smallRemoval,
    })
    expect(smallRemovalReply.status, JSON.stringify(smallRemovalReply.body)).toBe(200)
    expect(smallRemovalReply.body.failed).toEqual([])
    for (const id of smallRemoval) oracle.delete(id)
    expect(await reportedFull(otherNode, fullNodeId)).toBe(true)

    const singleRemoval = await request(otherNode.base, 'DELETE', `/indexes/${HEAVY_INDEX}/documents/${existingId}`)
    expect(singleRemoval.status).toBe(200)
    oracle.delete(existingId)
    const removable = [...oracle.keys()].slice(KEPT_DOCUMENTS)
    for (let start = 0; start < removable.length; start += REMOVE_BATCH_DOCUMENTS) {
      const docIds = removable.slice(start, start + REMOVE_BATCH_DOCUMENTS)
      const removal = await request(fullNode.base, 'POST', `/indexes/${HEAVY_INDEX}/documents/_batch`, {
        action: 'delete',
        docIds,
      })
      expect(removal.status, JSON.stringify(removal.body)).toBe(200)
      expect(removal.body.failed).toEqual([])
      for (const id of docIds) oracle.delete(id)
    }
    expect((await request(otherNode.base, 'GET', `/indexes/${HEAVY_INDEX}/count`)).body.count).toBe(oracle.size)

    const resumedAt = Date.now()
    await waitFor(`${fullNodeId} to accept inserts again`, RESUME_TIMEOUT_MS, async () => {
      const reply = await insertProbe(fullNode, HEAVY_INDEX, oracle)
      if (reply.status !== 201) expect(errorOf(reply).code).toBe('CLUSTER_WRITE_BLOCKED')
      return reply.status === 201
    })
    console.log(`${fullNodeId} accepted writes ${Date.now() - resumedAt} ms after the removes finished`)
    await waitFor(`${otherNode.nodeId} to accept inserts again`, PROPAGATION_TIMEOUT_MS, async () => {
      return (await insertProbe(otherNode, HEAVY_INDEX, oracle)).status === 201
    })
    expect(await reportedFull(otherNode, fullNodeId)).toBe(false)

    const keptId = [...oracle.keys()].find(id => id.startsWith('item-'))
    if (keptId === undefined) throw new Error('every filled document was removed')
    const updated = await request(otherNode.base, 'PATCH', `/indexes/${HEAVY_INDEX}/documents/${keptId}`, {
      document: replacement,
    })
    expect(updated.status, JSON.stringify(updated.body)).toBe(200)
    oracle.set(keptId, replacement)
    const batchAfter = await request(fullNode.base, 'POST', `/indexes/${HEAVY_INDEX}/documents/_batch`, {
      documents: [{ id: refusedId, ...replacement }],
    })
    expect(batchAfter.status, JSON.stringify(batchAfter.body)).toBe(200)
    oracle.set(refusedId, replacement)

    const finalChairs = await request(fullNode.base, 'POST', `/indexes/${HEAVY_INDEX}/search`, {
      term: 'chair',
      fields: ['title'],
      tolerance: 0,
      limit: 5,
    })
    expect(finalChairs.body.count).toBe(chairsIn(oracle))
    expect((await request(otherNode.base, 'GET', `/indexes/${HEAVY_INDEX}/count`)).body.count).toBe(oracle.size)
    expect((await request(otherNode.base, 'GET', `/indexes/${SPARE_INDEX}/count`)).body.count).toBe(spareOracle.size)
    await expectEveryDocumentReadsBack(otherNode.base, HEAVY_INDEX, oracle)
  }, 900_000)
})
