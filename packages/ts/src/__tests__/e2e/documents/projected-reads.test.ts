import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import type { DocumentProjection, FacetConfig, SortField } from '../../../types/search'

const INDEX = 'workshop'
const SCHEMA = { title: 'string', body: 'string', sku: 'string:pattern', embedding: 'vector[3]' } as const
const DOCUMENTS = 300
const LIMIT = 1_000
const COLOURS = ['red', 'Red', 'green', 'blue', 'ochre']
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const FACETS: FacetConfig = {
  title: {},
  'meta.colour': {},
  'meta.nested.deep': {},
  tags: {},
  'tags.0': {},
  mixed: {},
  naïve: {},
  'a.b': {},
  'meta.constructor': {},
  'meta.size': {
    ranges: [
      { from: 0, to: 4 },
      { from: 4, to: 20 },
    ],
  },
  weight: {
    ranges: [
      { from: 0, to: 6 },
      { from: 6, to: 100 },
    ],
  },
}
const SORTS: readonly SortField[][] = [
  [{ field: 'meta.size', direction: 'asc' }],
  [{ field: 'meta.nested.other', direction: 'desc' }],
  [{ field: 'weight', direction: 'asc' }],
  [{ field: 'tags', direction: 'desc' }],
  [{ field: 'mixed', direction: 'asc' }],
]
const PROJECTIONS: DocumentProjection[] = [
  { include: ['meta.nested.deep', 'tags', 'blob', 'made', 'naïve', 'a.b', 'missing.path'] },
  { include: ['meta'], exclude: ['meta.nested.other', 'meta.size'] },
  { exclude: ['body', 'meta.nested', 'embedding', 'blob'] },
  { include: ['tags.0', 'meta.__proto__', '__proto__', 'constructor.prototype', '..', 'title'] },
  { include: ['embedding', 'title'] },
  true,
]
const GROUP_FIELDS = ['meta.colour', 'tags.0', 'meta.nested.deep']

let directory: string | null = null
let engine: Narsil | null = null

afterEach(async () => {
  await engine?.shutdown()
  engine = null
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

function documentOf(serial: number, generation: number): AnyDocument {
  const shift = serial + generation * 7
  const document: Record<string, unknown> = {
    id: `w-${String(serial).padStart(3, '0')}`,
    title: `${COLOURS[shift % COLOURS.length]} bench`,
    body: serial % 3 === 0 ? 'item grain' : 'item',
    sku: `SKU-${shift % 37}-X`,
    embedding: [0.5, 0.25, shift % 4],
    tags: [`t${shift % 4}`, `t${shift % 6}`],
    blob: serial % 2 === 0 ? Buffer.from([shift % 256, 7, 0]) : Uint8Array.of(shift % 256, 7, 0),
    made: new Date(Date.UTC(2020, 0, 1 + (shift % 30))),
    mixed: shift % 3 === 0 ? `text ${shift % 5}` : shift % 7,
    naïve: shift % 2 === 0 ? 'ü' : 'u',
    'a.b': shift % 4,
  }
  if (shift % 10 === 3) document.meta = null
  else if (shift % 10 === 6) document.meta = [{ colour: 'inside a list' }]
  else if (shift % 10 !== 8) {
    document.meta = { colour: COLOURS[shift % 5], size: shift % 11, nested: { deep: `d${shift % 3}`, other: shift } }
  }
  if (shift % 2 === 0) document.weight = (shift % 13) * 1.5
  return document
}

function withPlainBytes(document: AnyDocument): AnyDocument {
  return { ...document, blob: Uint8Array.from(document.blob as Uint8Array) }
}

function valueAt(document: unknown, fieldPath: string): unknown {
  let current = document
  for (const segment of fieldPath.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function matching(held: ReadonlyMap<string, AnyDocument>, term: string): AnyDocument[] {
  return [...held.values()].filter(document => String(document.body).split(' ').includes(term))
}

function oracleFacets(documents: readonly AnyDocument[]): Record<string, Record<string, number>> {
  const facets: Record<string, Record<string, number>> = {}
  for (const [fieldPath, config] of Object.entries(FACETS)) {
    const counts: Record<string, number> = {}
    for (const document of documents) {
      const value = valueAt(document, fieldPath)
      if (config.ranges !== undefined) {
        for (const { from, to } of config.ranges) {
          const values = Array.isArray(value) ? value : [value]
          if (values.some(item => typeof item === 'number' && item >= from && item < to)) {
            counts[`${from}-${to}`] = (counts[`${from}-${to}`] ?? 0) + 1
          } else counts[`${from}-${to}`] ??= 0
        }
        continue
      }
      if (value === undefined || value === null) continue
      for (const item of Array.isArray(value) ? value : [value]) counts[String(item)] = (counts[String(item)] ?? 0) + 1
    }
    facets[fieldPath] = counts
  }
  return facets
}

function comparable(value: unknown, descending: boolean): string | number | boolean | null {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!Array.isArray(value)) return null
  let chosen: string | number | boolean | null = null
  for (const item of value) {
    const candidate = comparable(item, descending)
    if (candidate === null || Array.isArray(item)) continue
    if (
      chosen === null ||
      (descending ? comparePresent(candidate, chosen) > 0 : comparePresent(candidate, chosen) < 0)
    ) {
      chosen = candidate
    }
  }
  return chosen
}

function comparePresent(a: string | number | boolean, b: string | number | boolean): number {
  const rank = (value: unknown) => (typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const left = String(a)
  const right = String(b)
  if (left.toLowerCase() !== right.toLowerCase()) return left.toLowerCase() < right.toLowerCase() ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

function oracleSorted(documents: readonly AnyDocument[], sort: readonly SortField[]): string[] {
  const keyed = documents.map(document => ({
    id: String(document.id),
    key: sort.map(({ field, direction }) => comparable(valueAt(document, field), direction === 'desc')),
  }))
  keyed.sort((a, b) => {
    for (let at = 0; at < sort.length; at++) {
      const left = a.key[at]
      const right = b.key[at]
      if (left === null || right === null) {
        if (left !== right) return left === null ? 1 : -1
        continue
      }
      const order = comparePresent(left, right)
      if (order !== 0) return sort[at].direction === 'desc' ? -order : order
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return keyed.map(entry => entry.id)
}

function usablePath(path: string): string[] | null {
  const segments = path.split('.').filter(segment => segment.length > 0)
  return segments.length === 0 || segments.some(segment => RESERVED.has(segment)) ? null : segments
}

function readWithoutLists(document: unknown, segments: readonly string[]): { found: boolean; value: unknown } {
  let current = document
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !Object.hasOwn(current, segment)) {
      return { found: false, value: undefined }
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return { found: true, value: current }
}

function oracleProjected(document: AnyDocument, projection: DocumentProjection): unknown {
  if (projection === true) return document
  if (projection === false) return {}
  let projected: Record<string, unknown> = {}
  if (projection.include === undefined) projected = structuredClone(document)
  for (const path of projection.include ?? []) {
    const segments = usablePath(path)
    if (segments === null) continue
    const { found, value } = readWithoutLists(document, segments)
    if (!found) continue
    let target = projected
    for (const segment of segments.slice(0, -1)) {
      target[segment] ??= {}
      target = target[segment] as Record<string, unknown>
    }
    target[segments[segments.length - 1]] = structuredClone(value)
  }
  for (const path of projection.exclude ?? []) {
    const segments = usablePath(path)
    if (segments === null) continue
    const parent = readWithoutLists(projected, segments.slice(0, -1))
    if (parent.found && typeof parent.value === 'object' && parent.value !== null && !Array.isArray(parent.value)) {
      delete (parent.value as Record<string, unknown>)[segments[segments.length - 1]]
    }
  }
  return projected
}

function withPlainVectors(document: unknown): unknown {
  if (typeof document !== 'object' || document === null || !Object.hasOwn(document, 'embedding')) return document
  const record = document as Record<string, unknown>
  return { ...record, embedding: Array.from(record.embedding as ArrayLike<number>) }
}

async function expectOracle(narsil: Narsil, held: ReadonlyMap<string, AnyDocument>, label: string): Promise<void> {
  for (const term of ['item', 'grain']) {
    const documents = matching(held, term)
    const faceted = await narsil.query(INDEX, { term, limit: 1, facets: FACETS })
    const facets = Object.fromEntries(
      Object.entries(faceted.facets ?? {}).map(([field, result]) => [field, result.values]),
    )
    expect(facets, `${label} facets on ${term}`).toEqual(oracleFacets(documents))

    for (const sort of SORTS) {
      const sorted = await narsil.query(INDEX, { term, sort, limit: LIMIT, document: false })
      expect(
        sorted.hits.map(hit => hit.id),
        `${label} ${term} ${JSON.stringify(sort)}`,
      ).toEqual(oracleSorted(documents, sort))
    }

    const grouped = await narsil.query(INDEX, {
      term,
      limit: LIMIT,
      group: { fields: GROUP_FIELDS, maxPerGroup: LIMIT },
    })
    const groups = (grouped.groups ?? []).map(group => [
      JSON.stringify(group.values),
      group.hits.map(hit => hit.id).sort(),
    ])
    const expectedGroups = new Map<string, string[]>()
    for (const document of documents) {
      const values = Object.fromEntries(GROUP_FIELDS.map(field => [field, valueAt(document, field)]))
      const key = JSON.stringify(values)
      expectedGroups.set(key, [...(expectedGroups.get(key) ?? []), String(document.id)])
    }
    expect(groups.sort(), `${label} groups on ${term}`).toEqual(
      [...expectedGroups].map(([key, ids]) => [key, ids.sort()]).sort(),
    )

    for (const filter of [{ contains: '-1' }, { wildcard: 'SKU-*2-X' }]) {
      const filtered = await narsil.query(INDEX, {
        term,
        limit: LIMIT,
        document: false,
        filters: { fields: { sku: filter } },
      })
      const pattern =
        'contains' in filter ? (sku: string) => sku.includes('-1') : (sku: string) => /^SKU-.*2-X$/.test(sku)
      expect(filtered.hits.map(hit => hit.id).sort(), `${label} ${term} ${JSON.stringify(filter)}`).toEqual(
        documents
          .filter(document => pattern(String(document.sku)))
          .map(document => String(document.id))
          .sort(),
      )
    }

    for (const projection of PROJECTIONS) {
      const projected = await narsil.query(INDEX, { term, limit: LIMIT, document: projection })
      const byId = new Map(documents.map(document => [String(document.id), document]))
      for (const hit of projected.hits) {
        const document = byId.get(hit.id)
        if (document === undefined) throw new Error(`${hit.id} matched without holding ${term}`)
        expect(withPlainVectors(hit.document), `${label} ${hit.id} ${JSON.stringify(projection)}`).toEqual(
          oracleProjected(document, projection),
        )
      }
      expect(projected.hits.length, `${label} ${term} ${JSON.stringify(projection)}`).toBe(documents.length)
    }
  }
  expect(({} as Record<string, unknown>).polluted, label).toBeUndefined()
}

describe('reads that decode only the fields they need', () => {
  it('answer facets, sorts, groups, pattern tests, and projections from the stored document, in memory, frozen, and after writes', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-projected-reads-'))
    const config = { durability: { directory }, workers: { enabled: false } } as const
    const held = new Map<string, AnyDocument>()
    const writer = await createNarsil(config)
    engine = writer
    await writer.createIndex(INDEX, { schema: SCHEMA })
    const documents = Array.from({ length: DOCUMENTS }, (_, serial) => documentOf(serial, 0))
    expect((await writer.insertBatch(INDEX, documents)).failed).toEqual([])
    for (const document of documents) held.set(String(document.id), withPlainBytes(document))
    await expectOracle(writer, held, 'in memory')
    await writer.checkpoint(INDEX)
    await writer.shutdown()

    const reopened = await createNarsil(config)
    engine = reopened
    await expectOracle(reopened, held, 'on the frozen segment')

    const leaving = [...held.keys()].filter((_, at) => at % 13 === 5)
    expect((await reopened.removeBatch(INDEX, leaving)).failed).toEqual([])
    for (const docId of leaving) held.delete(docId)
    for (let serial = 2; serial < DOCUMENTS; serial += 17) {
      const replacement = documentOf(serial, 1)
      const docId = String(replacement.id)
      if (!held.has(docId)) continue
      await reopened.update(INDEX, docId, replacement)
      held.set(docId, withPlainBytes(replacement))
    }
    await expectOracle(reopened, held, 'after removes and updates of frozen documents')
  }, 120_000)
})
