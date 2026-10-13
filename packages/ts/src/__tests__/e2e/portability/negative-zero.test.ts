import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { bytesOf } from './archive-oracle'
import { temporaryRoots } from './harness'

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

function track(engine: Narsil): Narsil {
  engines.push(engine)
  return engine
}

const CONFIG = { schema: { title: 'string' as const, price: 'number' as const } }

const DOCUMENTS = [
  { id: 'flat', title: 'flat', price: -0 },
  { id: 'nested', title: 'nested', price: 4, readings: [-0, 2, 3.5], meta: { delta: -0, count: 7 } },
]

function expectSignedZeros(stored: Array<Record<string, unknown> | undefined>): void {
  const [flat, nested] = stored
  expect(Object.is(flat?.price, -0)).toBe(true)
  const readings = nested?.readings as number[] | undefined
  expect(Object.is(readings?.[0], -0)).toBe(true)
  expect(readings?.slice(1)).toEqual([2, 3.5])
  const meta = nested?.meta as { delta: number; count: number } | undefined
  expect(Object.is(meta?.delta, -0)).toBe(true)
  expect(meta?.count).toBe(7)
  expect(nested?.price).toBe(4)
}

async function storedOf(engine: Narsil, indexName: string): Promise<Array<Record<string, unknown> | undefined>> {
  return Promise.all(DOCUMENTS.map(document => engine.get(indexName, document.id)))
}

describe('a negative zero in a document', () => {
  it('comes back as negative zero after the log replays it and after a checkpoint reloads it', async () => {
    const directory = await roots.make('narsil-negative-zero-')
    const config = { workers: { enabled: false }, durability: { directory } }
    const writer = track(await createNarsil(config))
    await writer.createIndex('readings', CONFIG)
    expect((await writer.insertBatch('readings', DOCUMENTS)).failed).toEqual([])
    await writer.shutdown()

    const replayed = track(await createNarsil(config))
    expectSignedZeros(await storedOf(replayed, 'readings'))
    await replayed.checkpoint('readings')
    await replayed.shutdown()

    const reloaded = track(await createNarsil(config))
    expectSignedZeros(await storedOf(reloaded, 'readings'))
  })

  it('comes back as negative zero after a snapshot and a restore', async () => {
    const source = track(await createNarsil({ workers: { enabled: false } }))
    await source.createIndex('readings', CONFIG)
    expect((await source.insertBatch('readings', DOCUMENTS)).failed).toEqual([])
    const copy = track(await createNarsil({ workers: { enabled: false } }))
    await copy.restore('readings', await bytesOf(await source.snapshot('readings')))
    expectSignedZeros(await storedOf(copy, 'readings'))
  })
})
