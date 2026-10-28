import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import type { SortField } from '../../../types/search'
import { requireManifestOnDisk } from '../../persistence/durability/manifest-on-disk'

const INDEX = 'catalogue'
const SCHEMA = { title: 'string:sortable', price: 'number', body: 'string' } as const
const DOCUMENTS = 480
const PAGE = 70
const TITLES = ['oak', 'Oak', 'OAK chair', 'brass', 'Brass lamp', 'cedar', 'elm', 'Elm', 'zinc', 'amber']
const SORTS: readonly SortField[][] = [
  [{ field: 'title', direction: 'asc' }],
  [{ field: 'title', direction: 'desc' }],
  [{ field: 'price', direction: 'asc' }],
  [{ field: 'price', direction: 'desc' }],
  [
    { field: 'price', direction: 'asc' },
    { field: 'title', direction: 'desc' },
  ],
]
const TERMS = ['item', 'grain']

let directory: string | null = null
let engine: Narsil | null = null

afterEach(async () => {
  await engine?.shutdown()
  engine = null
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

function docIdOf(serial: number): string {
  return `doc-${String(serial).padStart(3, '0')}`
}

function documentOf(serial: number, generation: number): AnyDocument {
  const document: Record<string, unknown> = {
    id: docIdOf(serial),
    body: serial % 3 === 0 ? 'item grain' : 'item',
  }
  if ((serial + generation) % 9 !== 4) document.title = TITLES[(serial * 7 + generation * 3) % TITLES.length]
  if ((serial + generation) % 5 !== 2) document.price = ((serial + generation * 11) * 13) % 17
  return document
}

function oracleValue(document: AnyDocument, field: string): string | number | null {
  const value = document[field]
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

function compareOracleValues(a: string | number | null, b: string | number | null, descending: boolean): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  let order: number
  if (typeof a === 'number' && typeof b === 'number') order = a - b
  else {
    const left = String(a)
    const right = String(b)
    const foldedLeft = left.toLowerCase()
    const foldedRight = right.toLowerCase()
    if (foldedLeft !== foldedRight) order = foldedLeft < foldedRight ? -1 : 1
    else order = left === right ? 0 : left < right ? -1 : 1
  }
  return descending ? -order : order
}

function oracleOrder(held: ReadonlyMap<string, AnyDocument>, term: string, sort: readonly SortField[]): string[] {
  const matching = [...held.values()].filter(document => String(document.body).split(' ').includes(term))
  matching.sort((a, b) => {
    for (const { field, direction } of sort) {
      const order = compareOracleValues(oracleValue(a, field), oracleValue(b, field), direction === 'desc')
      if (order !== 0) return order
    }
    const left = String(a.id)
    const right = String(b.id)
    return left < right ? -1 : left > right ? 1 : 0
  })
  return matching.map(document => String(document.id))
}

async function engineOrder(narsil: Narsil, term: string, sort: SortField[], total: number): Promise<string[]> {
  const ids: string[] = []
  for (let offset = 0; offset < total + PAGE; offset += PAGE) {
    const result = await narsil.query(INDEX, { term, sort, limit: PAGE, offset, document: false })
    ids.push(...result.hits.map(hit => hit.id))
  }
  return ids
}

async function expectOracleOrder(narsil: Narsil, held: ReadonlyMap<string, AnyDocument>, label: string) {
  for (const term of TERMS) {
    for (const sort of SORTS) {
      const expected = oracleOrder(held, term, sort)
      expect(
        await engineOrder(narsil, term, sort, expected.length),
        `${label} ${term} ${JSON.stringify(sort)}`,
      ).toEqual(expected)
    }
  }
}

async function open(compactionThreshold: number): Promise<Narsil> {
  if (directory === null) throw new Error('the test opened no directory')
  engine = await createNarsil({ durability: { directory, compactionThreshold }, workers: { enabled: false } })
  return engine
}

async function close(): Promise<void> {
  await engine?.shutdown()
  engine = null
}

async function removeAndUpdate(narsil: Narsil, held: Map<string, AnyDocument>, generation: number, label: string) {
  const present = [...held.keys()].sort()
  for (let step = 0; step < 6; step++) {
    const docId = present[(step * 37 + generation * 5) % present.length]
    if (!held.has(docId)) continue
    await narsil.remove(INDEX, docId)
    held.delete(docId)
    await expectOracleOrder(narsil, held, `${label} after removing ${docId}`)
  }

  const leaving = present.filter((docId, at) => at % 23 === generation % 23 && held.has(docId))
  expect((await narsil.removeBatch(INDEX, leaving)).failed).toEqual([])
  for (const docId of leaving) held.delete(docId)
  await expectOracleOrder(narsil, held, `${label} after removing ${leaving.length} documents at once`)

  for (let serial = generation; serial < DOCUMENTS; serial += 29) {
    const docId = docIdOf(serial)
    if (!held.has(docId)) continue
    const replacement = documentOf(serial, generation)
    await narsil.update(INDEX, docId, replacement)
    held.set(docId, replacement)
  }
  await expectOracleOrder(narsil, held, `${label} after updating frozen documents`)
}

describe('sorted queries over frozen segments that lose documents', () => {
  it('keep the oracle order through removes, updates of frozen documents, and a merge, including ties and missing values', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-sorted-frozen-removals-'))
    const held = new Map<string, AnyDocument>()
    const first = await open(100)
    await first.createIndex(INDEX, { schema: SCHEMA })
    for (const half of [0, DOCUMENTS / 2]) {
      const documents = Array.from({ length: DOCUMENTS / 2 }, (_, at) => documentOf(half + at, 0))
      expect((await first.insertBatch(INDEX, documents)).failed).toEqual([])
      for (const document of documents) held.set(String(document.id), document)
      await first.checkpoint(INDEX)
    }
    await close()

    const reopened = await open(1)
    await expectOracleOrder(reopened, held, 'on two frozen segments')
    await removeAndUpdate(reopened, held, 1, 'before the merge')
    await reopened.checkpoint(INDEX)
    await close()
    const manifest = await requireManifestOnDisk(directory, INDEX)
    for (const partition of manifest.partitions) expect(partition.segments.length).toBe(1)

    const merged = await open(1)
    await expectOracleOrder(merged, held, 'on the merged segment')
    await removeAndUpdate(merged, held, 2, 'after the merge')
    await close()

    const restarted = await open(1)
    await expectOracleOrder(restarted, held, 'after a restart')
  }, 120_000)
})
