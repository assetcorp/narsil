import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import { errorCodeOf, errorFieldOf, sendRaw, startDocumentServer, stopDocumentServers } from '../documents/harness'

const INDEX = 'tracks'
const SCHEMA = {
  title: 'string',
  genre: 'enum',
  embedding: 'vector[3]',
  venue: 'geopoint',
  meta: { mood: 'string', voice: 'vector[2]' },
} as const
const ACCRA = { lat: 5.6037, lon: -0.187 }
const KUMASI = { lat: 6.6885, lon: -1.6244 }
const DOCUMENTS: AnyDocument[] = [
  {
    id: 'a',
    title: 'night drive',
    genre: 'jazz',
    embedding: [1, 0, 0],
    venue: ACCRA,
    meta: { mood: 'calm', voice: [1, 0] },
  },
  {
    id: 'b',
    title: 'night market',
    genre: 'jazz',
    embedding: [0, 1, 0],
    venue: ACCRA,
    meta: { mood: 'calm', voice: [0, 1] },
  },
  {
    id: 'c',
    title: 'night rain',
    genre: 'soul',
    embedding: [0, 0, 1],
    venue: KUMASI,
    meta: { mood: 'warm', voice: [1, 1] },
  },
]
const VECTOR_GROUPS: ReadonlyArray<{ fields: string[]; field: string; fieldType: string }> = [
  { fields: ['embedding'], field: 'embedding', fieldType: 'vector[3]' },
  { fields: ['genre', 'embedding'], field: 'embedding', fieldType: 'vector[3]' },
  { fields: ['meta.voice'], field: 'meta.voice', fieldType: 'vector[2]' },
]

let engine: Narsil | null = null

afterEach(async () => {
  await engine?.shutdown()
  engine = null
  await stopDocumentServers()
})

async function readyEngine(strict: boolean): Promise<Narsil> {
  engine = await createNarsil({ workers: { enabled: false } })
  await engine.createIndex(INDEX, { schema: SCHEMA, strict })
  expect((await engine.insertBatch(INDEX, DOCUMENTS)).failed).toEqual([])
  return engine
}

function venueGroupsOracle(): Array<{ venue: unknown; ids: string[] }> {
  const byVenue = new Map<string, { venue: unknown; ids: string[] }>()
  for (const document of DOCUMENTS) {
    const key = JSON.stringify(document.venue)
    const entry = byVenue.get(key) ?? { venue: document.venue, ids: [] }
    entry.ids.push(String(document.id))
    byVenue.set(key, entry)
  }
  return [...byVenue.values()].map(entry => ({ venue: entry.venue, ids: entry.ids.sort() }))
}

describe('grouping on a vector field', () => {
  for (const strict of [false, true]) {
    it(`refuses the query with SEARCH_INVALID_FIELD on a ${strict ? 'strict' : 'non-strict'} index`, async () => {
      const narsil = await readyEngine(strict)
      for (const { fields, field, fieldType } of VECTOR_GROUPS) {
        const failure = await narsil.query(INDEX, { term: 'night', group: { fields } }).catch(error => error)
        expect(failure, fields.join(',')).toBeInstanceOf(NarsilError)
        expect([(failure as NarsilError).code, (failure as NarsilError).details], fields.join(',')).toEqual([
          ErrorCodes.SEARCH_INVALID_FIELD,
          { field, fieldType },
        ])
      }
    })
  }

  it('still groups by a geopoint, one group for each distinct location', async () => {
    const narsil = await readyEngine(false)
    const result = await narsil.query(INDEX, { term: 'night', group: { fields: ['venue'], maxPerGroup: 10 } })
    const groups = (result.groups ?? []).map(group => ({
      venue: group.values.venue,
      ids: group.hits.map(hit => hit.id).sort(),
    }))
    expect(groups.sort((left, right) => left.ids[0].localeCompare(right.ids[0]))).toEqual(venueGroupsOracle())
  })

  it('answers the HTTP search with 400 and keeps serving', async () => {
    const { base, client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    await client.insertBatch(INDEX, DOCUMENTS)
    for (const { fields, field } of VECTOR_GROUPS) {
      const response = await sendRaw(
        base,
        'POST',
        `/indexes/${INDEX}/search`,
        JSON.stringify({ term: 'night', group: { fields } }),
      )
      expect([response.status, errorCodeOf(response.body), errorFieldOf(response.body)], fields.join(',')).toEqual([
        400,
        'SEARCH_INVALID_FIELD',
        field,
      ])
    }
    const grouped = await client.query(INDEX, { term: 'night', group: { fields: ['genre'], maxPerGroup: 10 } })
    expect((grouped.groups ?? []).map(group => group.hits.length).sort()).toEqual([1, 2])
  })
})
