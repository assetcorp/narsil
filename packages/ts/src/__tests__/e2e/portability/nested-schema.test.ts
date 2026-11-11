import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import type { AnyDocument, IndexConfig } from '../../../types/schema'
import { bytesOf, decodedPayload, entryNamed, readTar, resealed, withEntry, writeTar } from './archive-oracle'
import { ENGINE_KINDS, temporaryRoots } from './harness'

const VOYAGE_SCHEMA = {
  title: 'string',
  port: { name: 'string', country: 'enum', berth: { depth: 'number' } },
  crew: 'number',
} as const

const VOYAGE_CONFIG: IndexConfig = { schema: VOYAGE_SCHEMA, strict: true }

const FLAT_VOYAGE_SCHEMA: Record<string, string> = {
  title: 'string',
  'port.name': 'string',
  'port.country': 'enum',
  'port.berth.depth': 'number',
  crew: 'number',
}

const VOYAGES = 40

function voyage(n: number): AnyDocument {
  const southern = n % 3 === 0
  return {
    title: `voyage ${n} to the harbour`,
    port: {
      name: southern ? 'Lisbon quay' : 'Oslo slipway',
      country: southern ? 'pt' : 'no',
      berth: { depth: n + 0.5 },
    },
    crew: n,
  }
}

function southernCount(count: number): number {
  let southern = 0
  for (let n = 0; n < count; n++) if (n % 3 === 0) southern++
  return southern
}

async function refusalOf(engine: Narsil, indexName: string, data: Uint8Array): Promise<NarsilError> {
  try {
    await engine.restore(indexName, data)
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
  throw new Error('the engine restored an archive whose schema declares a path twice')
}

function withConfigSchema(archive: Uint8Array, schema: unknown): Uint8Array {
  const entries = readTar(archive)
  const config = resealed(entryNamed(entries, 'config').data, payload => ({ ...payload, schema }))
  return writeTar(withEntry(entries, 'config', config))
}

async function requireNestedIndex(engine: Narsil, indexName: string, voyages: number): Promise<void> {
  expect(engine.getStats(indexName).schema).toEqual(VOYAGE_SCHEMA)
  await engine.insert(indexName, voyage(voyages), `voyage-${voyages}`)
  const southern = await engine.query(indexName, {
    term: 'voyage',
    filters: { fields: { 'port.country': { eq: 'pt' } } },
    limit: 0,
  })
  expect(southern.count).toBe(southernCount(voyages + 1))
  const deep = await engine.query(indexName, {
    term: 'voyage',
    filters: { fields: { 'port.berth.depth': { gte: voyages } } },
    limit: 0,
  })
  expect(deep.count).toBe(1)
  const shallow = {
    title: 'voyage to a shallow berth',
    port: { name: 'Oslo slipway', country: 'no', berth: { depth: 'deep' } },
    crew: 1,
  }
  await expect(engine.insert(indexName, shallow, 'voyage-shallow')).rejects.toMatchObject({
    code: ErrorCodes.DOC_VALIDATION_FAILED,
  })
}

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  await roots.removeAll()
})

describe.each(ENGINE_KINDS)('a nested schema in the snapshot archive of $name', kind => {
  async function voyagesArchive() {
    const opened = await kind.open(roots)
    engines.push(opened.engine)
    await opened.engine.createIndex('voyages', VOYAGE_CONFIG)
    const batch = Array.from({ length: VOYAGES }, (_, n) => ({ id: `voyage-${n}`, ...voyage(n) }))
    const inserted = await opened.engine.insertBatch('voyages', batch)
    expect(inserted.failed).toEqual([])
    return { engine: opened.engine, archive: await bytesOf(await opened.engine.snapshot('voyages')) }
  }

  it('writes the schema as the flat map of field paths that the format sets', async () => {
    const { archive } = await voyagesArchive()
    const schema = decodedPayload(entryNamed(readTar(archive), 'config').data).schema as Record<string, string>
    expect(schema).toEqual(FLAT_VOYAGE_SCHEMA)
    expect(Object.keys(schema)).toEqual(Object.keys(FLAT_VOYAGE_SCHEMA))
  })

  it('restores the flat schema into an index that validates and filters nested documents', async () => {
    const { engine, archive } = await voyagesArchive()
    await engine.restore('restored', archive)
    await requireNestedIndex(engine, 'restored', VOYAGES)
  })

  it('still restores an archive whose schema an earlier release wrote nested', async () => {
    const { engine, archive } = await voyagesArchive()
    await engine.restore('restored', withConfigSchema(archive, VOYAGE_SCHEMA))
    await requireNestedIndex(engine, 'restored', VOYAGES)
  })

  it('refuses a stored schema that declares one path as a field and as an object of fields', async () => {
    const { engine, archive } = await voyagesArchive()
    const hostile: Array<Record<string, unknown>> = [
      { ...FLAT_VOYAGE_SCHEMA, port: 'string' },
      { ...FLAT_VOYAGE_SCHEMA, 'port.berth.depth.metres': 'number' },
      { ...FLAT_VOYAGE_SCHEMA, port: { name: 'string' } },
      { ...FLAT_VOYAGE_SCHEMA, '__proto__.polluted': 'string' },
      { ...FLAT_VOYAGE_SCHEMA, 'port..name': 'string' },
    ]
    for (const schema of hostile) {
      const refusal = await refusalOf(engine, 'restored', withConfigSchema(archive, schema))
      expect(refusal.code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
      expect(engine.listIndexes().some(index => index.name === 'restored')).toBe(false)
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
