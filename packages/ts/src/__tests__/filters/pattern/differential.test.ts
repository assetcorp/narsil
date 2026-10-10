import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument, IndexConfig } from '../../../types/schema'
import { referenceIds } from './fixtures'
import { changedPatternFields, type Random, randomDocument, randomProbe, seededRandom, valuesOf } from './random-corpus'

const INDEX = 'records'
const SEEDS = [1, 7, 42, 1_234, 98_765]
const ROUNDS = 4
const INSERTS_PER_ROUND = 60
const PROBES_PER_CHECK = 50
const LIST_LIMIT = 1_000
const FIELDS = ['code', 'tags', 'title'] as const

const config: IndexConfig = {
  schema: { body: 'string', rank: 'number', code: 'verbatim', tags: 'verbatim[]', title: 'string:pattern' },
  partitions: { maxPartitions: 3 },
}

const engines: Narsil[] = []

afterEach(async () => {
  for (const narsil of engines.splice(0)) await narsil.shutdown()
})

async function listed(narsil: Narsil, field: string, filter: FieldFilter): Promise<string[]> {
  const page = await narsil.listDocuments(INDEX, { filters: { fields: { [field]: filter } }, limit: LIST_LIMIT })
  return page.documents.map(document => document.id).sort()
}

async function queried(narsil: Narsil, field: string, filter: FieldFilter): Promise<string[]> {
  const result = await narsil.query(INDEX, {
    term: 'record',
    filters: { fields: { [field]: filter } },
    limit: LIST_LIMIT,
  })
  return result.hits.map(hit => hit.id).sort()
}

async function expectReference(
  narsil: Narsil,
  random: Random,
  documents: Map<string, AnyDocument>,
  stage: string,
): Promise<void> {
  const current = [...documents.values()]
  for (let probe = 0; probe < PROBES_PER_CHECK; probe++) {
    const field = FIELDS[probe % FIELDS.length]
    const filter = randomProbe(random, valuesOf(current, field))
    const expected = referenceIds(current, field, filter)
    const label = `${stage} ${field} ${JSON.stringify(filter)}`
    expect(await listed(narsil, field, filter), label).toEqual(expected)
    if (probe % 5 === 0) expect(await queried(narsil, field, filter), label).toEqual(expected)
  }
}

async function mutate(narsil: Narsil, random: Random, documents: Map<string, AnyDocument>, round: number) {
  const inserted = Array.from({ length: INSERTS_PER_ROUND }, (_, at) =>
    randomDocument(random, `d${round}-${String(at).padStart(3, '0')}`),
  )
  const result = await narsil.insertBatch(INDEX, inserted)
  expect(result.failed).toEqual([])
  for (const document of inserted) documents.set(String(document.id), document)

  for (const [id, document] of [...documents]) {
    const roll = random()
    if (roll < 0.15) {
      await narsil.remove(INDEX, id)
      documents.delete(id)
    } else if (roll < 0.4) {
      const changed = changedPatternFields(random, document)
      await narsil.update(INDEX, id, changed)
      documents.set(id, changed)
    } else if (roll < 0.45) {
      await narsil.remove(INDEX, id)
      const replacement = randomDocument(random, id)
      await narsil.insert(INDEX, replacement)
      documents.set(id, replacement)
    }
  }
}

describe('a pattern test on a randomly written index', () => {
  it.each(
    SEEDS,
  )('returns exactly the reference documents through writes, updates, removals, and a restore (seed %i)', async seed => {
    const random = seededRandom(seed)
    const narsil = await createNarsil({ workers: { enabled: false } })
    engines.push(narsil)
    await narsil.createIndex(INDEX, config)
    const documents = new Map<string, AnyDocument>()

    for (let round = 0; round < ROUNDS; round++) {
      await mutate(narsil, random, documents, round)
      await expectReference(narsil, random, documents, `round ${round}`)
    }

    const snapshot = await narsil.snapshot(INDEX)
    await narsil.dropIndex(INDEX)
    await narsil.restore(INDEX, snapshot)
    await expectReference(narsil, random, documents, 'restored')
  }, 60_000)
})
