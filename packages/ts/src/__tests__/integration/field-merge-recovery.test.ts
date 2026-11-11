import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { FilterExpression } from '../../types/filters'

type Row = {
  id: string
  title: string
  numbers?: number[]
  flags?: boolean[]
  tags?: string[]
  code?: string
  point?: { lat: number; lon: number }
  stored: number[]
  bucket: string
}

const BATCH_SIZE = 240
const BATCH_COUNT = 9
const TAGS = ['\ufeffamber', '\u{10000}amber', '\ue000amber', 'amber']

function rowAt(at: number, revision = 0): Row {
  const value = at + revision
  return {
    id: `row-${String(at).padStart(5, '0')}`,
    title: 'catalogue',
    ...(value % 7 === 0 ? {} : { numbers: value % 5 === 0 ? [] : [value % 11, value % 11, -(value % 13)] }),
    ...(value % 6 === 0 ? {} : { flags: value % 3 === 0 ? [] : value % 2 === 0 ? [true, false] : [false] }),
    ...(value % 8 === 0 ? {} : { tags: [TAGS[value % TAGS.length], TAGS[value % TAGS.length]] }),
    ...(value % 9 === 0 ? {} : { code: value % 2 === 0 ? 'mineral-amber' : 'mineral-quartz' }),
    ...(value % 10 === 0 ? {} : { point: { lat: value % 2 === 0 ? 0 : 50, lon: 0 } }),
    stored: [value % 17, value % 17],
    bucket: `bucket-${value % 4}`,
  }
}

const probes: Array<{ filter: FilterExpression; accepts: (row: Row) => boolean }> = [
  { filter: { fields: { numbers: { eq: 3 } } }, accepts: row => row.numbers?.includes(3) ?? false },
  { filter: { fields: { numbers: { size: { eq: 0 } } } }, accepts: row => row.numbers?.length === 0 },
  { filter: { fields: { flags: { eq: true } } }, accepts: row => row.flags?.includes(true) ?? false },
  { filter: { fields: { flags: { containsAll: [true, false] } } }, accepts: row => row.flags?.length === 2 },
  { filter: { fields: { tags: { eq: TAGS[0] } } }, accepts: row => row.tags?.includes(TAGS[0]) ?? false },
  { filter: { fields: { tags: { endsWith: 'amber' } } }, accepts: row => row.tags !== undefined },
  { filter: { fields: { code: { contains: 'amber' } } }, accepts: row => row.code?.includes('amber') ?? false },
  {
    filter: { fields: { point: { radius: { lat: 0, lon: 0, distance: 1, unit: 'km' } } } },
    accepts: row => row.point?.lat === 0,
  },
]

async function verify(engine: Narsil, held: ReadonlyMap<string, Row>): Promise<void> {
  await engine.waitForWrites('catalogue')
  const rows = [...held.values()]
  for (const { filter, accepts } of probes) {
    const expected = rows
      .filter(accepts)
      .map(row => row.id)
      .sort()
    const answer = await engine.query('catalogue', { term: 'catalogue', filters: filter, limit: 10_000 })
    expect(answer.count, JSON.stringify(filter)).toBe(expected.length)
    expect(answer.hits.map(hit => hit.id).sort(), JSON.stringify(filter)).toEqual(expected)
    for (const hit of answer.hits) expect(hit.document).toEqual(held.get(hit.id))
  }
  const answer = await engine.query('catalogue', {
    term: 'catalogue',
    limit: 0,
    document: false,
    facets: {
      stored: {
        ranges: [
          { from: 0, to: 8 },
          { from: 8, to: 17 },
        ],
      },
      tags: {},
    },
    group: { fields: ['bucket'], maxPerGroup: 2 },
  })
  expect(answer.facets?.stored.values).toEqual({
    '0-8': rows.filter(row => row.stored.some(value => value >= 0 && value < 8)).length,
    '8-17': rows.filter(row => row.stored.some(value => value >= 8 && value < 17)).length,
  })
  const tagCounts: Record<string, number> = {}
  for (const row of rows) for (const value of new Set(row.tags)) tagCounts[value] = (tagCounts[value] ?? 0) + 1
  expect(answer.facets?.tags.values).toEqual(tagCounts)
  const grouped = new Map(answer.groups?.map(group => [group.values.bucket, group.hits.map(hit => hit.id)]))
  expect(grouped.size).toBe(new Set(rows.map(row => row.bucket)).size)
  for (const bucket of new Set(rows.map(row => row.bucket)))
    expect(grouped.get(bucket)).toEqual(
      rows
        .filter(row => row.bucket === bucket)
        .map(row => row.id)
        .sort()
        .slice(0, 2),
    )
  const sorted = await engine.query('catalogue', { term: 'catalogue', sort: { stored: 'asc' }, limit: 10_000 })
  expect(sorted.hits.map(hit => hit.id)).toEqual(
    rows.sort((a, b) => a.stored[0] - b.stored[0] || (a.id < b.id ? -1 : 1)).map(row => row.id),
  )
}

it('preserves indexed and cached fields across worker merges, removals, updates, and recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-field-merge-'))
  let engine = await createNarsil({
    workers: { enabled: true, count: 2, promotionThreshold: 2, mainCopyQueries: 'none' },
    durability: { directory, compactionThreshold: 1 },
  })
  const held = new Map<string, Row>()
  try {
    await engine.createIndex('catalogue', {
      schema: {
        title: 'string',
        numbers: 'number[]',
        flags: 'boolean[]',
        tags: 'enum[]',
        code: 'verbatim',
        point: 'geopoint',
      },
      partitions: { maxPartitions: 1 },
    })
    for (let batch = 0; batch < BATCH_COUNT; batch++) {
      const rows = Array.from({ length: BATCH_SIZE }, (_, at) => rowAt(batch * BATCH_SIZE + at))
      expect((await engine.insertBatch('catalogue', rows)).failed).toEqual([])
      for (const row of rows) held.set(row.id, row)
      if (batch === 2) await verify(engine, held)
    }
    for (let at = 0; at < BATCH_SIZE * BATCH_COUNT; at += 13) {
      const row = rowAt(at)
      await engine.remove('catalogue', row.id)
      held.delete(row.id)
    }
    await verify(engine, held)
    await engine.checkpoint('catalogue')
    await engine.shutdown()
    engine = await createNarsil({ workers: { enabled: false }, durability: { directory, compactionThreshold: 1 } })
    await verify(engine, held)
    for (let at = 1; at < BATCH_SIZE * BATCH_COUNT; at += 17) {
      const row = rowAt(at, 3)
      if (held.has(row.id)) await engine.update('catalogue', row.id, row)
      else await engine.insert('catalogue', row)
      held.set(row.id, row)
    }
    await verify(engine, held)
    await engine.checkpoint('catalogue')
    await engine.shutdown()
    engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
    await verify(engine, held)
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
