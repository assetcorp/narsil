import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import type { NarsilEventMap } from '../../../types/events'
import type { AnyDocument } from '../../../types/schema'
import { decodedPayload, openEnvelope, resealed } from './archive-oracle'
import { temporaryRoots } from './harness'
import { copyReleaseFixture, expectedFixtureDocuments, expectFixtureDocuments } from './release-0.3-fixture'

const roots = temporaryRoots()
const engines: Narsil[] = []
const EARLIER_GRAPH_FILE = 'products/segments/vec-embedding-1l4nfg2-graph-g1'

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

function track(engine: Narsil): Narsil {
  engines.push(engine)
  return engine
}

function holdsWord(document: AnyDocument, word: string): boolean {
  const text = [document.title, document.body, ...((document.tags as string[] | undefined) ?? [])].join(' ')
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .includes(word)
}

async function filesUnder(root: string, prefix: string): Promise<string[]> {
  const all = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1))
  return all.filter(name => name.startsWith(prefix)).sort()
}

function listedKeys(manifest: Record<string, unknown>): string[] {
  const partitions = manifest.partitions as Array<{ segments: Array<{ key: string }> }>
  const vectors = manifest.vectors as Array<{ files: Array<{ key: string }>; graphParts: Array<{ key: string }> }>
  return [
    ...partitions.flatMap(partition => partition.segments.map(segment => segment.key)),
    ...vectors.flatMap(field => [...field.files, ...field.graphParts].map(file => file.key)),
  ].sort()
}

describe('an index that release 0.3 saved with a write-ahead log', () => {
  async function openUpgraded() {
    const directory = await roots.make('narsil-upgrade-wal-')
    await copyReleaseFixture('wal', directory)
    const config = { workers: { enabled: false }, durability: { directory } }
    return { directory, config, engine: track(await createNarsil(config)) }
  }

  it('opens with every document, every vector, and every write its log held', async () => {
    const { engine } = await openUpgraded()
    const products = await expectedFixtureDocuments('wal-expected.json')
    const notes = await expectedFixtureDocuments('wal-notes-expected.json')

    await expectFixtureDocuments(engine, 'products', products, 'embedding')
    await expectFixtureDocuments(engine, 'notes', notes, null)
    expect(engine.getStats('notes').partitionCount).toBe(4)

    const harbour = Object.values(products).filter(document => holdsWord(document, 'harbour')).length
    expect((await engine.query('products', { term: 'harbour', limit: 400 })).count).toBe(harbour)
    const target = products['doc-0002'].embedding as number[]
    const nearest = await engine.query('products', { vector: { field: 'embedding', value: target }, limit: 1 })
    expect(nearest.hits[0]?.id).toBe('doc-0002')
  })

  it('rewrites the index in the current layout, removes the earlier files, and upgrades once', async () => {
    const { directory, config, engine } = await openUpgraded()
    await engine.shutdown()

    const manifestBytes = new Uint8Array(await readFile(join(directory, 'products', 'manifest')))
    const manifest = decodedPayload(manifestBytes)
    expect(manifest.version).toBe(7)
    expect(await filesUnder(directory, 'products/segments/')).toEqual(listedKeys(manifest))
    expect(await filesUnder(directory, EARLIER_GRAPH_FILE)).toEqual([])
    expect(decodedPayload(new Uint8Array(await readFile(join(directory, 'notes', 'manifest')))).version).toBe(7)

    const reopened = track(await createNarsil(config))
    await expectFixtureDocuments(reopened, 'products', await expectedFixtureDocuments('wal-expected.json'), 'embedding')
    await reopened.shutdown()
    expect(new Uint8Array(await readFile(join(directory, 'products', 'manifest')))).toEqual(manifestBytes)
  })

  it('keeps the writes that follow the upgrade across a restart', async () => {
    const { config, engine } = await openUpgraded()
    const products = await expectedFixtureDocuments('wal-expected.json')
    await engine.insert('products', { ...products['doc-0001'], title: 'lantern after the upgrade' }, 'after-1')
    await engine.remove('products', 'doc-0005')
    await engine.update('products', 'doc-0006', { ...products['doc-0006'], title: 'quay renamed' })
    await engine.checkpoint('products')
    await engine.insert('products', { ...products['doc-0001'], title: 'beacon after the checkpoint' }, 'after-2')
    await engine.shutdown()

    const reopened = track(await createNarsil(config))
    expect(await reopened.countDocuments('products')).toBe(Object.keys(products).length + 1)
    expect(await reopened.get('products', 'doc-0005')).toBeUndefined()
    expect((await reopened.get('products', 'doc-0006'))?.title).toBe('quay renamed')
    expect((await reopened.get('products', 'after-1'))?.title).toBe('lantern after the upgrade')
    expect((await reopened.get('products', 'after-2'))?.title).toBe('beacon after the checkpoint')
  })

  it('reports the start and the end of each upgrade when indexes open on first use', async () => {
    const directory = await roots.make('narsil-upgrade-events-')
    await copyReleaseFixture('wal', directory)
    const engine = track(
      await createNarsil({ workers: { enabled: false }, durability: { directory }, lifecycle: { maxOpenIndexes: 4 } }),
    )
    const events: Array<NarsilEventMap['layoutUpgrade']> = []
    engine.on('layoutUpgrade', event => {
      events.push(event)
    })

    await engine.query('products', { term: 'harbour' })

    expect(events.map(({ indexName, status, layout }) => ({ indexName, status, layout }))).toEqual([
      { indexName: 'products', status: 'started', layout: 'manifest' },
      { indexName: 'products', status: 'completed', layout: 'manifest' },
    ])
  })

  it('refuses a manifest of a layout before release 0.3, naming the export as the way across', async () => {
    const directory = await roots.make('narsil-upgrade-too-old-')
    await copyReleaseFixture('wal', directory)
    const path = join(directory, 'products', 'manifest')
    await writeFile(
      path,
      resealed(new Uint8Array(await readFile(path)), raw => ({ ...raw, version: 5 })),
    )

    await expect(createNarsil({ workers: { enabled: false }, durability: { directory } })).rejects.toMatchObject({
      code: ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      message: expect.stringMatching(/export/i),
    })
  })
})

describe('an index that release 0.3 saved through a persistence adapter', () => {
  it('rewrites the snapshot bundle as segments and keeps every document', async () => {
    const directory = await roots.make('narsil-upgrade-bundle-')
    await copyReleaseFixture('snapshot-tier', directory)
    const config = {
      workers: { enabled: false },
      persistence: createFilesystemPersistence({ directory }),
      durability: { tier: 'snapshot' as const },
    }
    const expected = await expectedFixtureDocuments('snapshot-tier-expected.json')

    const engine = track(await createNarsil(config))
    await expectFixtureDocuments(engine, 'products', expected, 'embedding')
    await engine.shutdown()

    expect(await filesUnder(directory, 'products/snapshot')).toEqual([])
    const manifest = decodedPayload(new Uint8Array(await readFile(join(directory, 'products', 'manifest'))))
    expect(manifest.version).toBe(7)
    expect(openEnvelope(new Uint8Array(await readFile(join(directory, 'products', 'manifest')))).version).toBe(2)

    const reopened = track(await createNarsil(config))
    await expectFixtureDocuments(reopened, 'products', expected, 'embedding')
  })
})
