import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { FieldFilter } from '../../types/filters'
import type { AnyDocument } from '../../types/schema'
import { referenceIds } from '../filters/pattern/fixtures'
import { seededRandom } from '../filters/pattern/random-corpus'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

const INDEX = 'operations'
const DOCUMENT_COUNT = 4_000
const LIST_LIMIT = 5_000
const SERVICES = ['payment-service', 'Payment-Gateway', 'inventory', 'Straße-Router', 'auth']
const LEVELS = ['ERROR', 'error', 'WARN', 'info', 'Info']
const MESSAGES = [
  'Connection refused to 10.0.0.12:5432',
  'connection REFUSED to 10.0.0.7:6379',
  'Timeout after 3000 ms',
  'Disk full on /var/lib/data',
  'Größe überschritten',
  'retrying 😀 later',
]
const PEOPLE = ['Ama.Mensah', 'kofi.boateng', 'Efua.Owusu', 'yaw.asante', 'ADJOA.DARKO']
const DOMAINS = ['example.com', 'Example.org', 'mail.example.com']

function operationsCorpus(): AnyDocument[] {
  const random = seededRandom(2_026)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  return Array.from({ length: DOCUMENT_COUNT }, (_, at) => {
    const day = String(1 + (at % 28)).padStart(2, '0')
    const line = `2024-03-${day}T10:${String(at % 60).padStart(2, '0')}:00Z ${pick(LEVELS)} [${pick(SERVICES)}] ${pick(MESSAGES)} (attempt ${1 + (at % 5)})`
    const order = `ORD-${2020 + (at % 6)}-${String(at).padStart(6, '0')}`
    const contacts = Array.from({ length: at % 4 }, () => `${pick(PEOPLE)}@${pick(DOMAINS)}`)
    return { id: `op${String(at).padStart(5, '0')}`, body: 'operation', line, order, contacts }
  })
}

const PROBES: Array<[string, FieldFilter]> = [
  ['line', { contains: 'refused' }],
  ['line', { contains: 'refused', caseFold: true }],
  ['line', { contains: 'ERROR [payment', caseFold: true }],
  ['line', { contains: 'strasse-router', caseFold: true }],
  ['line', { contains: 'GRÖSSE', caseFold: true }],
  ['line', { startsWith: '2024-03-07T10:1' }],
  ['line', { endsWith: '(attempt 3)' }],
  ['line', { endsWith: 'LATER (ATTEMPT 2)', caseFold: true }],
  ['line', { contains: '😀' }],
  ['line', { contains: 'e' }],
  ['line', { contains: 'zzz' }],
  ['order', { eq: 'ORD-2023-000123' }],
  ['order', { eq: 'ord-2023-000123', caseFold: true }],
  ['order', { contains: '-0001' }],
  ['order', { startsWith: 'ORD-2025' }],
  ['order', { ne: 'ORD-2020-000000' }],
  ['order', { in: ['ORD-2021-000001', 'ORD-2024-003994', 'ORD-1999-000000'] }],
  ['order', { nin: ['ord-2021-000001'], caseFold: true }],
  ['contacts', { contains: 'ama.mensah@', caseFold: true }],
  ['contacts', { endsWith: '@example.org' }],
  ['contacts', { endsWith: '@example.org', caseFold: true }],
  ['contacts', { eq: 'kofi.boateng@mail.example.com' }],
  ['contacts', { nin: ['kofi.boateng@example.com'] }],
]

const engines: Narsil[] = []

afterEach(async () => {
  for (const narsil of engines.splice(0)) await narsil.shutdown()
})

async function engineWith(config: NarsilConfig, documents: AnyDocument[]): Promise<Narsil> {
  const narsil = await createNarsil(config)
  engines.push(narsil)
  await narsil.createIndex(INDEX, {
    schema: { body: 'string', line: 'string:pattern', order: 'verbatim', contacts: 'verbatim[]' },
    partitions: { maxPartitions: 4 },
  })
  const inserted = await narsil.insertBatch(INDEX, documents)
  expect(inserted.failed).toEqual([])
  return narsil
}

async function waitForCopies(narsil: Narsil): Promise<void> {
  const start = Date.now()
  for (;;) {
    const stats = await narsil.getMemoryStats()
    if (stats.workerCopies.some(copy => copy.indexName === INDEX && copy.scaledOut)) return
    if (Date.now() - start > 30_000) throw new Error('The index never gained worker copies')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function expectReference(narsil: Narsil, documents: AnyDocument[]): Promise<void> {
  for (const [field, filter] of PROBES) {
    const expected = referenceIds(documents, field, filter)
    const label = `${field} ${JSON.stringify(filter)}`
    const listed = await narsil.listDocuments(INDEX, { filters: { fields: { [field]: filter } }, limit: LIST_LIMIT })
    expect(listed.documents.map(document => document.id).sort(), label).toEqual(expected)
    const queried = await narsil.query(INDEX, {
      term: 'operation',
      filters: { fields: { [field]: filter } },
      limit: LIST_LIMIT,
    })
    expect(queried.hits.map(hit => hit.id).sort(), label).toEqual(expected)
  }
}

describe('pattern tests over a corpus of log lines, order codes, and email addresses', () => {
  const documents = operationsCorpus()

  it('return exactly the reference documents within the default work cap', async () => {
    const narsil = await engineWith({ workers: { enabled: false } }, documents)
    await expectReference(narsil, documents)
  }, 60_000)

  it.skipIf(!built)(
    'return the same documents when worker copies answer the search',
    async () => {
      const narsil = await engineWith(
        { workers: { promotionThreshold: 500, count: 4, mainCopyQueries: 'none' } },
        documents,
      )
      await waitForCopies(narsil)
      const warnings = vi.spyOn(console, 'warn')
      try {
        await expectReference(narsil, documents)
        expect(warnings.mock.calls.filter(call => String(call[0]).includes('Worker search failed'))).toEqual([])
      } finally {
        warnings.mockRestore()
      }
    },
    60_000,
  )
})
