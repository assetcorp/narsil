import { randomUUID } from 'node:crypto'
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
  isServerMemoryRefusal,
  type NodeProcess,
  request,
  startNodeProcess,
  waitFor,
} from './harness'

const HEAP_MEGABYTES = 192
const INDEX_NAME = 'catalogue'
const PROPAGATION_TIMEOUT_MS = 20_000
const BATCH_TEXT_CHARACTERS = 1_000_000
const SEND_BUDGET_HEAP_LIMITS = 3
const DOCUMENT_TEXT_CHARACTERS = 1_000
const MANY_FIELDS = 200
const ARRAY_ITEMS = 500
const HAN_START = 0x4e00
const HAN_SPAN = 20_000
const HAN_TERM_CHARACTERS = 100

type Document = Record<string, unknown> & { id: string }

interface HostileShape {
  name: string
  config: Record<string, unknown>
  document: () => Record<string, unknown>
}

let counter = 0
let hanState = 7

function distinctTerm(): string {
  counter += 1
  return counter.toString(36)
}

function randomHan(length: number): string {
  let run = ''
  for (let index = 0; index < length; index++) {
    hanState = (Math.imul(hanState, 1_103_515_245) + 12_345) >>> 0
    run += String.fromCharCode(HAN_START + (hanState % HAN_SPAN))
  }
  return run
}

function sentenceOfDistinctTerms(): string {
  const terms: string[] = []
  let length = 0
  while (length < DOCUMENT_TEXT_CHARACTERS) {
    const term = distinctTerm()
    terms.push(term)
    length += term.length + 1
  }
  return terms.join(' ')
}

function hanTerms(): string {
  const terms: string[] = []
  for (let length = 0; length < DOCUMENT_TEXT_CHARACTERS; length += HAN_TERM_CHARACTERS + 1) {
    terms.push(randomHan(HAN_TERM_CHARACTERS))
  }
  return terms.join(' ')
}

const manyFieldsSchema = Object.fromEntries(Array.from({ length: MANY_FIELDS }, (_, index) => [`f${index}`, 'string']))

const SHAPES: HostileShape[] = [
  {
    name: 'distinct terms',
    config: { schema: { body: 'string' } },
    document: () => ({ body: sentenceOfDistinctTerms() }),
  },
  {
    name: 'distinct terms in a pattern and partial-word field',
    config: { schema: { body: 'string:pattern:partial' } },
    document: () => ({ body: sentenceOfDistinctTerms() }),
  },
  {
    name: 'long distinct Han terms in a pattern field',
    config: { schema: { body: 'string:pattern' } },
    document: () => ({ body: hanTerms() }),
  },
  {
    name: 'Chinese text whose every bigram is new',
    config: { schema: { body: 'string' }, language: 'chinese' },
    document: () => ({ body: randomHan(DOCUMENT_TEXT_CHARACTERS) }),
  },
  {
    name: 'a custom tokeniser that emits a term for every character',
    config: { schema: { body: 'string' }, tokenizer: 'three-character-shingles' },
    document: () => ({ body: randomHan(DOCUMENT_TEXT_CHARACTERS) }),
  },
  {
    name: 'two hundred text fields',
    config: { schema: manyFieldsSchema },
    document: () => Object.fromEntries(Object.keys(manyFieldsSchema).map(field => [field, distinctTerm()])),
  },
  {
    name: 'a string array of distinct items',
    config: { schema: { tags: 'string[]' } },
    document: () => ({ tags: Array.from({ length: ARRAY_ITEMS }, distinctTerm) }),
  },
  {
    name: 'an enum array of distinct values',
    config: { schema: { tags: 'enum[]' } },
    document: () => ({ tags: Array.from({ length: ARRAY_ITEMS }, distinctTerm) }),
  },
  {
    name: 'a verbatim array of distinct values',
    config: { schema: { tags: 'verbatim[]' } },
    document: () => ({ tags: Array.from({ length: ARRAY_ITEMS }, distinctTerm) }),
  },
  {
    name: 'a number array',
    config: { schema: { values: 'number[]' } },
    document: () => ({ values: Array.from({ length: ARRAY_ITEMS }, () => (counter += 1)) }),
  },
  {
    name: 'fields the schema leaves out',
    config: { schema: { title: 'string' } },
    document: () => ({
      title: distinctTerm(),
      ...Object.fromEntries(Array.from({ length: MANY_FIELDS }, () => [distinctTerm(), distinctTerm()])),
    }),
  },
]

function textCharactersOf(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (typeof value === 'number') return 8
  if (Array.isArray(value)) return value.reduce((total: number, item) => total + textCharactersOf(item), 0)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).reduce((total, [key, item]) => total + key.length + textCharactersOf(item), 0)
  }
  return 0
}

function batchOf(shape: HostileShape, batch: number): Document[] {
  const documents: Document[] = []
  let characters = 0
  while (characters < BATCH_TEXT_CHARACTERS) {
    const document = { id: `doc-${batch}-${documents.length}`, ...shape.document() }
    characters += textCharactersOf(document)
    documents.push(document)
  }
  return documents
}

interface BatchFailure {
  docId: string
  error: { code: string; details?: Record<string, unknown> }
}

describe('a cluster node with a 192 MB heap, written to with hostile documents', () => {
  let container: EtcdContainerHandle | null = null
  let node: NodeProcess | null = null

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
    await node?.stop()
    node = null
  }, 60_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
  }, 60_000)

  it.each(SHAPES)('indexes or refuses $name and stays up', async shape => {
    if (container === null) throw new Error('etcd never started')
    const started = await startNodeProcess({
      nodeId: 'node-1',
      etcdEndpoint: container.endpoint,
      keyPrefix: `_narsil_write_hostile_${randomUUID()}`,
      heapMegabytes: HEAP_MEGABYTES,
    })
    node = started
    const created = await request(started.base, 'POST', '/indexes', { name: INDEX_NAME, config: shape.config })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await waitFor(`${INDEX_NAME} to have an active primary`, PROPAGATION_TIMEOUT_MS, async () => {
      const reply = await request(started.base, 'GET', `/indexes/${INDEX_NAME}/cluster`)
      const partitions = (reply.body.partitions ?? []) as Array<{ primary: string | null; state: string }>
      return partitions.some(partition => partition.state === 'ACTIVE' && partition.primary !== null)
    })

    const acknowledged = new Map<string, Document>()
    let refusals = 0
    let sentBytes = 0
    const sendBudgetBytes = started.heapLimitBytes * SEND_BUDGET_HEAP_LIMITS
    for (let batch = 0; sentBytes < sendBudgetBytes && refusals === 0; batch++) {
      const documents = batchOf(shape, batch)
      sentBytes += JSON.stringify({ documents }).length
      const reply = await request(started.base, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, {
        documents,
      }).catch(() => null)
      expect(
        reply?.status,
        `the node stopped answering after it acknowledged ${acknowledged.size} documents: ${started.output().slice(-2_000)}`,
      ).toBeDefined()
      if (reply === null) return
      expect([200, 429], JSON.stringify(reply.body).slice(0, 500)).toContain(reply.status)
      if (reply.status === 429) {
        if (!isServerMemoryRefusal(reply)) expect(errorOf(reply).code).toBe('CLUSTER_WRITE_BLOCKED')
        refusals++
        continue
      }
      const failed = reply.body.failed as BatchFailure[]
      for (const failure of failed) expect(failure.error.code, JSON.stringify(failure)).toBe('CLUSTER_WRITE_BLOCKED')
      refusals += failed.length
      const sent = new Map(documents.map(document => [document.id, document]))
      for (const docId of reply.body.succeeded as string[]) {
        const document = sent.get(docId)
        expect(document, `the node acknowledged ${docId}, which the batch never held`).toBeDefined()
        if (document !== undefined) acknowledged.set(docId, document)
      }
    }

    console.log(`${shape.name}: ${acknowledged.size} documents kept, ${refusals} refusals`)
    expect(
      refusals,
      `the node refused nothing after ${sentBytes} bytes of documents, ${SEND_BUDGET_HEAP_LIMITS} times its heap limit`,
    ).toBeGreaterThan(0)
    const counted = await request(started.base, 'GET', `/indexes/${INDEX_NAME}/count`)
    expect(counted.body.count).toBe(acknowledged.size)
    await expectEveryDocumentReadsBack(started.base, INDEX_NAME, acknowledged)
    expect(started.exited(), started.output()).toBe(false)
  }, 600_000)
})
