import { describe, expect, it } from 'vitest'
import { getLanguage } from '../../../languages/registry'
import { createPartitionManager, type PartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { buildSnapshotBundleBytes } from '../../../persistence/durability/checkpoint'
import { loadSnapshotBundleBytes } from '../../../persistence/durability/recovery'
import { SINGLE_NODE_PRIMARY_TERM } from '../../../persistence/durability/seq-owner'
import { concatEnvelopeParts } from '../../../serialization/envelope'
import type { IndexConfig } from '../../../types/schema'

const config: IndexConfig = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

function makeManager(partitionCount: number): PartitionManager {
  return createPartitionManager('movies', config, getLanguage('english'), createPartitionRouter(), partitionCount)
}

async function bundleBytesFor(manager: PartitionManager): Promise<Uint8Array> {
  const seqNoByPartition = new Map<number, number>()
  const primaryTermByPartition = new Map<number, number>()
  for (let i = 0; i < manager.partitionCount; i += 1) {
    seqNoByPartition.set(i, 0)
    primaryTermByPartition.set(i, SINGLE_NODE_PRIMARY_TERM)
  }
  const { parts } = await buildSnapshotBundleBytes({
    indexName: 'movies',
    schema: { title: 'string', year: 'number' },
    language: 'english',
    manager,
    vectorIndexes: new Map(),
    seqNoByPartition,
    primaryTermByPartition,
  })
  return concatEnvelopeParts(parts)
}

function emptyDeps(manager: PartitionManager) {
  return { manager, vectorFieldPaths: new Set<string>(), vectorIndexes: new Map() }
}

describe('loadSnapshotBundleBytes partition reconciliation', () => {
  it('trims a wider manager down to the bundle and drops documents outside it', async () => {
    const source = makeManager(2)
    const sourceDocs: string[] = []
    for (let i = 0; i < 20; i++) {
      const docId = `src-${i}`
      source.insert(docId, { title: `Source movie ${i}`, year: 1990 + i })
      sourceDocs.push(docId)
    }
    const bytes = await bundleBytesFor(source)

    const target = makeManager(4)
    const router = createPartitionRouter()
    const outsideBundle: string[] = []
    for (let i = 0; i < 40; i++) {
      const docId = `local-${i}`
      target.insert(docId, { title: `Local movie ${i}`, year: 2020 })
      if (router.route(docId, 4) >= 2) {
        outsideBundle.push(docId)
      }
    }
    expect(outsideBundle.length).toBeGreaterThan(0)

    await loadSnapshotBundleBytes(bytes, emptyDeps(target))

    expect(target.partitionCount).toBe(2)
    expect(target.countDocuments()).toBe(sourceDocs.length)
    for (const docId of sourceDocs) {
      expect(target.has(docId)).toBe(true)
      expect(target.get(docId)?.title).toBe(source.get(docId)?.title)
    }
    for (const docId of outsideBundle) {
      expect(target.has(docId)).toBe(false)
    }
    expect(target.partitionAt(2)).toBeUndefined()
  })

  it('grows a narrower manager up to the bundle', async () => {
    const source = makeManager(3)
    for (let i = 0; i < 15; i++) {
      source.insert(`g-${i}`, { title: `Growing movie ${i}`, year: 2000 + i })
    }
    const bytes = await bundleBytesFor(source)

    const target = makeManager(1)
    await loadSnapshotBundleBytes(bytes, emptyDeps(target))

    expect(target.partitionCount).toBe(3)
    expect(target.countDocuments()).toBe(15)
    for (let i = 0; i < 15; i++) {
      expect(target.has(`g-${i}`)).toBe(true)
    }
  })

  it('replaces the contents of a same-width manager exactly', async () => {
    const source = makeManager(2)
    source.insert('only-doc', { title: 'The only one', year: 2001 })
    const bytes = await bundleBytesFor(source)

    const target = makeManager(2)
    for (let i = 0; i < 10; i++) {
      target.insert(`stale-${i}`, { title: `Stale movie ${i}`, year: 1980 })
    }

    await loadSnapshotBundleBytes(bytes, emptyDeps(target))

    expect(target.partitionCount).toBe(2)
    expect(target.countDocuments()).toBe(1)
    expect(target.has('only-doc')).toBe(true)
    for (let i = 0; i < 10; i++) {
      expect(target.has(`stale-${i}`)).toBe(false)
    }
  })
})

describe('a recovered document owns the memory of its binary fields', () => {
  const vectorSchema = { title: 'string', embedding: 'vector[8]' } as const

  function makeVectorManager(): PartitionManager {
    return createPartitionManager(
      'vectors',
      { schema: vectorSchema, language: 'english' },
      getLanguage('english'),
      createPartitionRouter(),
      1,
    )
  }

  it('reads a vector back without the snapshot buffer behind it', async () => {
    const source = makeVectorManager()
    for (let i = 0; i < 25; i++) {
      source.insert(`vec-${i}`, { title: `Vector document ${i}`, embedding: new Float32Array(8).fill(i / 25) })
    }
    const { parts } = await buildSnapshotBundleBytes({
      indexName: 'vectors',
      schema: vectorSchema,
      language: 'english',
      manager: source,
      vectorIndexes: new Map(),
      seqNoByPartition: new Map([[0, 0]]),
      primaryTermByPartition: new Map([[0, SINGLE_NODE_PRIMARY_TERM]]),
    })

    const target = makeVectorManager()
    await loadSnapshotBundleBytes(concatEnvelopeParts(parts), emptyDeps(target))

    const recovered = target.get('vec-0')?.embedding
    if (!ArrayBuffer.isView(recovered)) throw new Error('the recovered document lost its embedding')
    expect(recovered.buffer.byteLength).toBe(recovered.byteLength)
  })
})
