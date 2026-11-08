import { isDeepStrictEqual } from 'node:util'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

type Listing = { id: string; title: string; spec?: unknown; rank?: unknown }

const specs: unknown[] = [
  { size: 'M', colours: ['red', 'blue'] },
  { size: 'L', colours: [] },
  'boxed',
  7,
  true,
  ['loose', { size: 'S' }],
  { size: 'M', colours: ['red', 'blue'] },
  { nested: { depth: { of: [1, 2, { three: null }] } } },
  null,
  undefined,
]

const ranks: unknown[] = [4, { tier: 'gold' }, -2, undefined, 4, { tier: 'silver' }, 0, 11.5]

function byId(left: Listing, right: Listing): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function expectedGroups(rows: readonly Listing[]): Listing[][] {
  const groups: Listing[][] = []
  for (const row of [...rows].sort(byId)) {
    const group = groups.find(members => isDeepStrictEqual(members[0].spec ?? null, row.spec ?? null))
    if (group === undefined) groups.push([row])
    else group.push(row)
  }
  return groups
}

function expectedFacet(rows: readonly Listing[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null)
  for (const row of rows) {
    for (const value of Array.isArray(row.spec) ? row.spec : [row.spec]) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
      counts[String(value)] = (counts[String(value)] ?? 0) + 1
    }
  }
  return counts
}

function expectedRankOrder(rows: readonly Listing[], direction: 'asc' | 'desc'): string[] {
  const ranked = rows.filter(row => typeof row.rank === 'number')
  const missing = rows.filter(row => typeof row.rank !== 'number').sort(byId)
  ranked.sort((left, right) => {
    const difference = (left.rank as number) - (right.rank as number)
    return (direction === 'asc' ? difference : -difference) || byId(left, right)
  })
  return [...ranked, ...missing].map(row => row.id)
}

async function checkReads(engine: Narsil, rows: ReadonlyMap<string, Listing>): Promise<void> {
  const all = [...rows.values()]
  const answer = await engine.query('listings', {
    term: 'listing',
    bm25: { b: 0 },
    document: false,
    limit: all.length,
    group: { fields: ['spec'], maxPerGroup: all.length },
    facets: { spec: {} },
  })
  const groups = expectedGroups(all)
  expect(answer.groups?.map(group => group.hits.map(hit => hit.id))).toEqual(
    groups.map(members => members.map(row => row.id)),
  )
  expect(answer.groups?.map(group => group.values.spec ?? null)).toEqual(groups.map(members => members[0].spec ?? null))
  expect(answer.facets?.spec.values).toEqual(expectedFacet(all))
  for (const direction of ['asc', 'desc'] as const) {
    const sorted = await engine.query('listings', {
      term: 'listing',
      sort: { rank: direction },
      limit: all.length,
      document: false,
    })
    expect(sorted.hits.map(hit => hit.id)).toEqual(expectedRankOrder(all, direction))
    const listed = await engine.listDocuments('listings', { sort: { rank: direction }, limit: all.length })
    expect(listed.documents.map(document => document.id)).toEqual(expectedRankOrder(all, direction))
  }
}

it('groups, facets, and sorts by an undeclared field that holds objects, from the first query on', async () => {
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    await engine.createIndex('listings', { schema: { title: 'string' } })
    const rows = new Map<string, Listing>()
    for (let at = 0; at < 40; at++) {
      const spec = specs[at % specs.length]
      const rank = ranks[at % ranks.length]
      const row: Listing = {
        id: `listing-${String(at).padStart(2, '0')}`,
        title: 'listing',
        ...(spec === undefined ? {} : { spec }),
        ...(rank === undefined ? {} : { rank }),
      }
      rows.set(row.id, row)
    }
    expect((await engine.insertBatch('listings', [...rows.values()])).failed).toEqual([])
    await checkReads(engine, rows)

    for (const row of rows.values()) {
      const at = Number(row.id.slice('listing-'.length))
      if (at % 3 !== 0) continue
      const changed: Listing = {
        ...row,
        spec: { size: 'XL', colours: [String(at % 2)], edition: { year: 2000 + (at % 4) } },
        rank: at % 2 === 0 ? { tier: `tier-${at}` } : at / 4,
      }
      rows.set(row.id, changed)
      await engine.update('listings', row.id, changed)
    }
    const added: Listing = {
      id: 'listing-zz',
      title: 'listing',
      spec: { size: 'M', colours: ['red', 'blue'] },
      rank: -9,
    }
    rows.set(added.id, added)
    await engine.insert('listings', added)
    await engine.remove('listings', 'listing-01')
    rows.delete('listing-01')
    await checkReads(engine, rows)
  } finally {
    await engine.shutdown()
  }
}, 30_000)
