import { cp, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import { expectLayout } from '../../engine/partition-layout-oracle'
import { temporaryRoots } from './harness'
import { expectFixtureDocuments } from './release-0.3-fixture'

const FIXTURE = new URL('../../../../../conformance/samples/earlier-releases/a6ddec94/', import.meta.url)
const INDEX = 'catalog'
const SAVED_PARTITION_COUNT = 4
const LATER_DOCUMENTS = 60

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

async function expectedDocuments(): Promise<Map<string, AnyDocument>> {
  const parsed = JSON.parse(await readFile(new URL('expected/rebalanced-catalog.json', FIXTURE), 'utf8'))
  return new Map(Object.entries(parsed as Record<string, AnyDocument>))
}

function titlesOf(documents: ReadonlyMap<string, AnyDocument>): Map<string, string> {
  return new Map([...documents].map(([id, document]) => [id, String(document.title)]))
}

async function openedCopy(): Promise<{ directory: string; open: () => Promise<Narsil> }> {
  const directory = await roots.make('narsil-rebalanced-fixture-')
  await cp(fileURLToPath(new URL('rebalanced/', FIXTURE)), directory, { recursive: true })
  return {
    directory,
    async open() {
      const engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
      engines.push(engine)
      return engine
    },
  }
}

async function insertLater(engine: Narsil, documents: Map<string, AnyDocument>): Promise<void> {
  for (let at = 0; at < LATER_DOCUMENTS; at += 1) {
    const id = `later-${at}`
    const document = { title: `cobble later ${at}`, body: 'cobble', tags: ['cobble'], price: at + 0.5, inStock: true }
    await engine.insert(INDEX, document, id)
    documents.set(id, document)
  }
}

describe('an index that a rebalance past the default maxPartitions of one saved', () => {
  it('opens with its four partitions and every document, and keeps both across later writes and a restart', async () => {
    const expected = await expectedDocuments()
    const copy = await openedCopy()
    const engine = await copy.open()

    await expectFixtureDocuments(engine, INDEX, Object.fromEntries(expected), null)
    await expectLayout(engine, INDEX, titlesOf(expected), SAVED_PARTITION_COUNT)

    await insertLater(engine, expected)
    await engine.checkpoint(INDEX)
    await engine.shutdown()
    const reopened = await copy.open()

    await expectFixtureDocuments(reopened, INDEX, Object.fromEntries(expected), null)
    await expectLayout(reopened, INDEX, titlesOf(expected), SAVED_PARTITION_COUNT)
  })

  it('refuses a rebalance and a maxPartitions above the default of one, and accepts a rebalance down to one', async () => {
    const expected = await expectedDocuments()
    const copy = await openedCopy()
    const engine = await copy.open()

    for (const target of [2, SAVED_PARTITION_COUNT, SAVED_PARTITION_COUNT + 1]) {
      await expect(engine.rebalance(INDEX, target)).rejects.toMatchObject({
        code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
        details: { targetPartitionCount: target, maxPartitions: 1 },
      })
    }
    await expect(engine.updatePartitionConfig(INDEX, { maxPartitions: 2 })).rejects.toMatchObject({
      code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      details: { maxPartitions: 2, partitionCount: SAVED_PARTITION_COUNT },
    })
    await expectLayout(engine, INDEX, titlesOf(expected), SAVED_PARTITION_COUNT)

    await engine.rebalance(INDEX, 1)
    await expectLayout(engine, INDEX, titlesOf(expected), 1)
    await insertLater(engine, expected)
    await engine.checkpoint(INDEX)
    await engine.shutdown()
    const reopened = await copy.open()

    await expectFixtureDocuments(reopened, INDEX, Object.fromEntries(expected), null)
    await expectLayout(reopened, INDEX, titlesOf(expected), 1)
  })
})
