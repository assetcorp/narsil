import { describe, expect, it, vi } from 'vitest'
import type { Narsil } from '../../narsil'
import type { FilterExpression } from '../../types/filters'

interface Shelf {
  id: string
  code?: string
  tags: string[]
}

const CODE_WORDS = ['alder', 'Alder', 'birch', 'Birch', 'cedar', 'ELM', 'elm', 'fir', 'Fir', 'larch', 'oak', 'Oak']
const TAG_WORDS = ['red', 'blue', 'green']

const shelves: Shelf[] = Array.from({ length: 60 }, (_, at) => ({
  id: `shelf-${String(at).padStart(2, '0')}`,
  code: at % 13 === 0 ? undefined : `${CODE_WORDS[at % CODE_WORDS.length]}-${String((at * 7) % 10)}`,
  tags: TAG_WORDS.filter((_, tag) => (at >> tag) % 2 === 1),
}))

function compareSortStrings(left: string, right: string): number {
  const foldedLeft = left.toLowerCase()
  const foldedRight = right.toLowerCase()
  const order = (a: string, b: string): number => {
    const length = Math.min(a.length, b.length)
    for (let at = 0; at < length; at++) {
      const difference = (a.codePointAt(at) ?? 0) - (b.codePointAt(at) ?? 0)
      if (difference !== 0) return difference
    }
    return a.length - b.length
  }
  return order(foldedLeft, foldedRight) || order(left, right)
}

function codeWithin(
  shelf: Shelf,
  lower: string | null,
  lowerInclusive: boolean,
  upper: string | null,
  upperInclusive: boolean,
): boolean {
  if (shelf.code === undefined) return false
  if (lower !== null) {
    const against = compareSortStrings(shelf.code, lower)
    if (against < 0 || (against === 0 && !lowerInclusive)) return false
  }
  if (upper !== null) {
    const against = compareSortStrings(shelf.code, upper)
    if (against > 0 || (against === 0 && !upperInclusive)) return false
  }
  return true
}

function oracleIds(accepts: (shelf: Shelf) => boolean): string[] {
  return shelves
    .filter(accepts)
    .map(shelf => shelf.id)
    .sort()
}

async function freshEngineWithShelves(): Promise<Narsil> {
  vi.resetModules()
  const { createNarsil } = await import('../../narsil')
  const narsil = await createNarsil({ workers: { enabled: false } })
  await narsil.createIndex('shelves', {
    schema: { title: 'string', code: 'verbatim:sortable', tags: 'enum[]' },
  })
  await narsil.insertBatch(
    'shelves',
    shelves.map(({ id, code, tags }) => ({ id, title: 'shelf', tags, ...(code === undefined ? {} : { code }) })),
  )
  return narsil
}

async function queriedIds(narsil: Narsil, filters: FilterExpression): Promise<string[]> {
  const result = await narsil.query('shelves', { term: 'shelf', filters, limit: 100 })
  return result.hits.map(hit => hit.id).sort()
}

async function listedIds(narsil: Narsil, filters: FilterExpression): Promise<string[]> {
  const result = await narsil.listDocuments('shelves', { filters, limit: 100 })
  return result.documents.map(listed => listed.id).sort()
}

const firstFilters: Array<{ name: string; filters: FilterExpression; accepts: (shelf: Shelf) => boolean }> = [
  {
    name: 'a gt bound under or, beside a list test',
    filters: { or: [{ fields: { code: { gt: 'fir-3' } } }, { fields: { tags: { matchesAny: ['green'] } } }] },
    accepts: shelf => codeWithin(shelf, 'fir-3', false, null, false) || shelf.tags.includes('green'),
  },
  {
    name: 'an lte bound under not',
    filters: { not: { fields: { code: { lte: 'Cedar-5' } } } },
    accepts: shelf => !codeWithin(shelf, null, false, 'Cedar-5', true),
  },
  {
    name: 'a between test under not under or, in the same field tests as a list test',
    filters: {
      or: [
        { not: { fields: { code: { between: ['birch-0', 'Elm-9'] }, tags: { containsAll: ['red'] } } } },
        { fields: { tags: { matchesAny: ['blue'] } } },
      ],
    },
    accepts: shelf =>
      !(codeWithin(shelf, 'birch-0', true, 'Elm-9', true) && shelf.tags.includes('red')) || shelf.tags.includes('blue'),
  },
  {
    name: 'a gte bound that a getter returns',
    filters: {
      fields: {
        code: {
          get gte(): string {
            return 'oak-0'
          },
        },
      },
    },
    accepts: shelf => codeWithin(shelf, 'oak-0', true, null, false),
  },
]

describe('a range test on text as the first filter that an engine sees', () => {
  for (const { name, filters, accepts } of firstFilters) {
    it(`answers a query that carries ${name}`, async () => {
      const narsil = await freshEngineWithShelves()
      try {
        expect(await queriedIds(narsil, filters)).toEqual(oracleIds(accepts))
      } finally {
        await narsil.shutdown()
      }
    })

    it(`answers a listing that carries ${name}`, async () => {
      const narsil = await freshEngineWithShelves()
      try {
        expect(await listedIds(narsil, filters)).toEqual(oracleIds(accepts))
      } finally {
        await narsil.shutdown()
      }
    })
  }
})
