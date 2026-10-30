import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { FieldFilter } from '../../../types/filters'

const INDEX = 'products'
const SEEDS = [3, 29, 404]
const DOCUMENTS = 600
const UPDATES_PER_ROUND = 1_600
const CHECK_EVERY = 1_200
const ROUNDS = 3
const SHARED_PRICE = 500
const LIST_LIMIT = 1_000
const EARTH_RADIUS_METRES = 6_371_008.8
const BOUNDARY_MARGIN = 0.005
const PRICE_RANGES = [
  { from: 0, to: 250 },
  { from: 250, to: 500 },
  { from: 500, to: 501 },
  { from: 501, to: 1_000 },
]

type Product = {
  id: string
  title: string
  price: number
  sizes: number[]
  location: { lat: number; lon: number }
}

type Random = () => number

const engines: Narsil[] = []

afterEach(async () => {
  for (const narsil of engines.splice(0)) await narsil.shutdown()
})

function seeded(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0
    return state / 4_294_967_296
  }
}

function product(random: Random, id: string): Product {
  const sizes = Array.from({ length: 1 + Math.floor(random() * 3) }, () => Math.floor(random() * 6))
  return {
    id,
    title: `chair ${id}`,
    price: random() < 0.5 ? SHARED_PRICE : Math.floor(random() * 1_000),
    sizes,
    location: { lat: 51 + Math.floor(random() * 40) * 0.005, lon: -0.2 + Math.floor(random() * 40) * 0.005 },
  }
}

function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = toRadians(b.lat - a.lat)
  const dLon = toRadians(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(h))
}

function idsWhere(documents: Map<string, Product>, keep: (document: Product) => boolean): string[] {
  return [...documents.values()]
    .filter(keep)
    .map(document => document.id)
    .sort()
}

async function listed(narsil: Narsil, field: string, filter: unknown): Promise<string[]> {
  const page = await narsil.listDocuments(INDEX, {
    filters: { fields: { [field]: filter as FieldFilter } },
    limit: LIST_LIMIT,
  })
  return page.documents.map(document => document.id).sort()
}

function nonZero(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).filter(([, count]) => count > 0))
}

async function expectOracle(narsil: Narsil, random: Random, documents: Map<string, Product>, stage: string) {
  const low = Math.floor(random() * 900)
  const high = low + Math.floor(random() * 200)
  expect(await listed(narsil, 'price', { between: [low, high] }), `${stage} between`).toEqual(
    idsWhere(documents, d => d.price >= low && d.price <= high),
  )
  expect(await listed(narsil, 'price', { eq: SHARED_PRICE }), `${stage} eq`).toEqual(
    idsWhere(documents, d => d.price === SHARED_PRICE),
  )
  expect(await listed(narsil, 'price', { gt: SHARED_PRICE }), `${stage} gt`).toEqual(
    idsWhere(documents, d => d.price > SHARED_PRICE),
  )
  expect(await listed(narsil, 'price', { lt: low }), `${stage} lt`).toEqual(idsWhere(documents, d => d.price < low))
  const size = Math.floor(random() * 6)
  expect(await listed(narsil, 'sizes', { eq: size }), `${stage} sizes eq`).toEqual(
    idsWhere(documents, d => d.sizes.includes(size)),
  )

  const centre = { lat: 51.1, lon: -0.1 }
  let radius = 2_000 + Math.floor(random() * 6_000)
  while (
    [...documents.values()].some(d => Math.abs(metresBetween(centre, d.location) - radius) < radius * BOUNDARY_MARGIN)
  ) {
    radius += 37
  }
  expect(
    await listed(narsil, 'location', { radius: { ...centre, distance: radius, unit: 'm' } }),
    `${stage} radius ${radius}`,
  ).toEqual(idsWhere(documents, d => metresBetween(centre, d.location) <= radius))

  const result = await narsil.query(INDEX, {
    term: 'chair',
    sort: { price: 'asc' },
    facets: { price: { ranges: PRICE_RANGES }, sizes: { limit: 100 } },
    limit: LIST_LIMIT,
  })
  const prices = [...documents.values()].map(d => d.price).sort((a, b) => a - b)
  expect(
    result.hits.map(hit => documents.get(hit.id)?.price),
    `${stage} sort`,
  ).toEqual(prices)
  const rangeCounts: Record<string, number> = {}
  for (const range of PRICE_RANGES) {
    rangeCounts[`${range.from}-${range.to}`] = [...documents.values()].filter(
      d => d.price >= range.from && d.price < range.to,
    ).length
  }
  expect(nonZero(result.facets?.price?.values ?? {}), `${stage} price ranges`).toEqual(nonZero(rangeCounts))
  const sizeCounts: Record<string, number> = {}
  for (const document of documents.values()) {
    for (const value of new Set(document.sizes)) sizeCounts[String(value)] = (sizeCounts[String(value)] ?? 0) + 1
  }
  expect(result.facets?.sizes?.values, `${stage} sizes facet`).toEqual(sizeCounts)
}

describe('sorted field indexes under updates', () => {
  it.each(
    SEEDS,
  )('answers numeric and geo filters, facets, and sorts exactly as a scan of the documents does (seed %i)', async seed => {
    const random = seeded(seed)
    const narsil = await createNarsil({ workers: { enabled: false } })
    engines.push(narsil)
    await narsil.createIndex(INDEX, {
      schema: { title: 'string', price: 'number', sizes: 'number[]', location: 'geopoint' },
    })
    const documents = new Map<string, Product>()
    const initial = Array.from({ length: DOCUMENTS }, (_, at) => product(random, `p${at}`))
    expect((await narsil.insertBatch(INDEX, initial)).failed).toEqual([])
    for (const document of initial) documents.set(document.id, document)
    await expectOracle(narsil, random, documents, 'loaded')

    for (let round = 0; round < ROUNDS; round++) {
      for (let step = 0; step < UPDATES_PER_ROUND; step++) {
        const id = `p${Math.floor(random() * DOCUMENTS)}`
        const roll = random()
        if (!documents.has(id)) {
          const created = product(random, id)
          await narsil.insert(INDEX, created)
          documents.set(id, created)
        } else if (roll < 0.1) {
          await narsil.remove(INDEX, id)
          documents.delete(id)
        } else {
          const changed = product(random, id)
          await narsil.update(INDEX, id, changed)
          documents.set(id, changed)
        }
        if (step % 400 === 399) await expectOracle(narsil, random, documents, `round ${round} step ${step}`)
      }
      if (round === 1) {
        const snapshot = await narsil.snapshot(INDEX)
        await narsil.dropIndex(INDEX)
        await narsil.restore(INDEX, snapshot)
        await expectOracle(narsil, random, documents, 'restored')
      }
    }
  }, 60_000)
})
