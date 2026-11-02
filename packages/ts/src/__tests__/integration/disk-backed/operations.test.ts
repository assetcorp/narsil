import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createNarsil } from '../../../narsil'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig } from '../../../types/schema'
import { bytesOf } from '../../e2e/portability/archive-oracle'
import {
  ArticleOracle,
  expectEngineMatchesOracle,
  expectSearchesMatchOracle,
  randomArticle,
  seededRandom,
  VOCABULARY,
} from './oracle'

const INDEX = 'articles'

const ARTICLE_CONFIG: IndexConfig = {
  schema: { title: 'string', body: 'string', year: 'number' },
  language: 'english',
  textStorage: 'disk',
  surfaceForms: true,
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

async function writeRound(
  engine: Narsil,
  oracle: ArticleOracle,
  random: () => number,
  prefix: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const document = randomArticle(random)
    await engine.insert(INDEX, document, `${prefix}-${i}`)
    oracle.set(`${prefix}-${i}`, document)
  }
  const known = [...oracle.documents.keys()]
  for (let i = 0; i < Math.floor(count / 4); i++) {
    const id = known[Math.floor(random() * known.length)]
    if (!oracle.documents.has(id)) continue
    if (random() < 0.5) {
      await engine.remove(INDEX, id)
      oracle.delete(id)
    } else {
      const replacement = randomArticle(random)
      await engine.update(INDEX, id, replacement)
      oracle.set(id, replacement)
    }
  }
}

describe('an index with its text on disk, through the operations that move its files', () => {
  const roots: string[] = []
  const engines: Narsil[] = []

  async function newRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'narsil-disk-operations-'))
    roots.push(root)
    return root
  }

  async function open(root: string, extra: Partial<Parameters<typeof createNarsil>[0]> = {}): Promise<Narsil> {
    const engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false }, ...extra })
    engines.push(engine)
    return engine
  }

  beforeEach(() => {
    roots.length = 0
    engines.length = 0
  })

  afterEach(async () => {
    for (const engine of engines) await engine.shutdown().catch(() => undefined)
    for (const root of roots) await rm(root, { recursive: true, force: true })
  })

  async function seeded(engine: Narsil, seed: number): Promise<ArticleOracle> {
    await engine.createIndex(INDEX, ARTICLE_CONFIG)
    const random = seededRandom(seed)
    const oracle = new ArticleOracle()
    await writeRound(engine, oracle, random, 'first', 400)
    await engine.checkpoint(INDEX)
    await writeRound(engine, oracle, random, 'second', 200)
    await engine.checkpoint(INDEX)
    await writeRound(engine, oracle, random, 'third', 60)
    return oracle
  }

  it('restores a snapshot under another engine and keeps taking writes through a restart', async () => {
    const source = await open(await newRoot())
    const oracle = await seeded(source, 11)
    const archive = await bytesOf(await source.snapshot(INDEX))

    const targetRoot = await newRoot()
    let target = await open(targetRoot)
    await target.restore(INDEX, archive)
    await expectEngineMatchesOracle(target, INDEX, oracle)

    const random = seededRandom(12)
    await writeRound(target, oracle, random, 'after-restore', 100)
    await target.checkpoint(INDEX)
    await expectEngineMatchesOracle(target, INDEX, oracle)
    await target.shutdown()
    target = await open(targetRoot)
    await expectEngineMatchesOracle(target, INDEX, oracle)
  }, 120_000)

  it('restores a snapshot over its own index while that index holds other documents', async () => {
    const root = await newRoot()
    let engine = await open(root)
    const oracle = await seeded(engine, 13)
    const archive = await bytesOf(await engine.snapshot(INDEX))
    await engine.insert(INDEX, { title: 'amber', body: 'amber', year: 1990 }, 'discarded-by-restore')
    await engine.checkpoint(INDEX)
    await engine.restore(INDEX, archive)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await engine.shutdown()
    engine = await open(root)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
  }, 120_000)

  it('refuses a damaged snapshot archive and keeps the index that it would replace', async () => {
    const root = await newRoot()
    const engine = await open(root)
    const oracle = await seeded(engine, 14)
    await engine.checkpoint(INDEX)
    const archive = await bytesOf(await engine.snapshot(INDEX))
    const damaged = archive.slice()
    damaged[Math.floor(damaged.length / 2)] ^= 0xff
    await expect(engine.restore(INDEX, damaged)).rejects.toMatchObject({ name: 'NarsilError' })
    await expectEngineMatchesOracle(engine, INDEX, oracle)
  }, 120_000)

  it('exports every live document once and imports them into a memory index that answers alike', async () => {
    const engine = await open(await newRoot())
    const oracle = await seeded(engine, 15)
    await engine.checkpoint(INDEX)
    const lines = new TextDecoder()
      .decode(await bytesOf(await engine.exportDocuments(INDEX)))
      .trim()
      .split('\n')
    const exported = lines.slice(1).map(line => JSON.parse(line) as { id: string; year: number; title: string })
    expect(exported.map(document => document.id).sort()).toEqual([...oracle.documents.keys()].sort())
    for (const document of exported) {
      expect(document.title).toBe(oracle.documents.get(document.id)?.title)
    }
    const other = await open(await newRoot())
    await other.importDocumentExport(INDEX, new TextEncoder().encode(`${lines.join('\n')}\n`))
    await expectSearchesMatchOracle(other, INDEX, oracle)
  }, 120_000)

  it('answers alike after an idle close and the reopen that the next read causes', async () => {
    const engine = await open(await newRoot(), { lifecycle: { idleTimeoutMs: 100 } })
    const oracle = await seeded(engine, 16)
    await engine.checkpoint(INDEX)
    await expect
      .poll(() => engine.listIndexes().find(index => index.name === INDEX)?.state, { timeout: 15_000 })
      .toBe('closed')
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    expect(engine.listIndexes().find(index => index.name === INDEX)?.reopenCount).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('merges many segments, answers alike throughout, and removes the merged files', async () => {
    const root = await newRoot()
    let engine = await open(root)
    await engine.createIndex(INDEX, ARTICLE_CONFIG)
    const random = seededRandom(17)
    const oracle = new ArticleOracle()
    let most = 0
    for (let round = 0; round < 14; round++) {
      await writeRound(engine, oracle, random, `round-${round}`, 60)
      await engine.checkpoint(INDEX)
      const segments = (await filesUnder(root)).filter(file => file.includes('segments'))
      most = Math.max(most, segments.length)
      if (round % 5 === 4) await expectEngineMatchesOracle(engine, INDEX, oracle)
    }
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await engine.shutdown()
    engine = await open(root)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await engine.checkpoint(INDEX)
    const left = (await filesUnder(root)).filter(file => file.includes('segments'))
    expect(left.length).toBeLessThanOrEqual(most)
  }, 180_000)

  it('moves documents between partitions through a rebalance and answers alike after a restart', async () => {
    const root = await newRoot()
    let engine = await open(root)
    const oracle = await seeded(engine, 18)
    await engine.checkpoint(INDEX)
    await engine.rebalance(INDEX, 3)
    expect(engine.getPartitionStats(INDEX)).toHaveLength(3)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await writeRound(engine, oracle, seededRandom(19), 'after-rebalance', 100)
    await engine.checkpoint(INDEX)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await engine.shutdown()
    engine = await open(root)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
  }, 180_000)

  it('scores like a memory index across several partitions, with removals, after a restart', async () => {
    const root = await newRoot()
    let disk = await open(root)
    await disk.createIndex(INDEX, ARTICLE_CONFIG)
    const memory = await createNarsil({ workers: { enabled: false } })
    engines.push(memory)
    await memory.createIndex(INDEX, { ...ARTICLE_CONFIG, textStorage: 'memory' })
    const random = seededRandom(22)
    for (let i = 0; i < 400; i++) {
      const document = randomArticle(random)
      await disk.insert(INDEX, document, `doc-${i}`)
      await memory.insert(INDEX, document, `doc-${i}`)
    }
    await disk.rebalance(INDEX, 3)
    await memory.rebalance(INDEX, 3)
    await disk.checkpoint(INDEX)
    for (let i = 0; i < 400; i += 7) {
      await disk.remove(INDEX, `doc-${i}`)
      await memory.remove(INDEX, `doc-${i}`)
    }
    await disk.checkpoint(INDEX)
    await disk.shutdown()
    disk = await open(root)
    for (const word of VOCABULARY) {
      const fromDisk = await disk.query(INDEX, { term: word, limit: 500 })
      const fromMemory = await memory.query(INDEX, { term: word, limit: 500 })
      const scoreById = new Map(fromMemory.hits.map(hit => [hit.id, hit.score]))
      expect(fromDisk.hits.map(hit => hit.id).sort()).toEqual([...scoreById.keys()].sort())
      for (const hit of fromDisk.hits) expect(hit.score).toBeCloseTo(scoreById.get(hit.id) ?? Number.NaN, 8)
    }
  }, 180_000)

  it('answers alike after a rebuild of its analysis and a restart', async () => {
    const root = await newRoot()
    let engine = await open(root)
    const oracle = await seeded(engine, 20)
    await engine.checkpoint(INDEX)
    await engine.rebuildAnalysis(INDEX)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await engine.checkpoint(INDEX)
    await engine.shutdown()
    engine = await open(root)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
  }, 180_000)

  it('forgets every document on clear and on a drop, and leaves no segment file behind a drop', async () => {
    const root = await newRoot()
    const engine = await open(root)
    await seeded(engine, 21)
    await engine.checkpoint(INDEX)
    await engine.clear(INDEX)
    await expectEngineMatchesOracle(engine, INDEX, new ArticleOracle())
    await engine.checkpoint(INDEX)
    const fresh = new ArticleOracle()
    await writeRound(engine, fresh, seededRandom(22), 'after-clear', 50)
    await engine.checkpoint(INDEX)
    await expectEngineMatchesOracle(engine, INDEX, fresh)
    await engine.dropIndex(INDEX)
    expect((await filesUnder(root)).filter(file => file.includes(INDEX))).toEqual([])
    await engine.createIndex(INDEX, ARTICLE_CONFIG)
    await expectEngineMatchesOracle(engine, INDEX, new ArticleOracle())
  }, 120_000)

  it('spills a rebalance and a rebuild that outgrow memory, and leaves no spilled file behind', async () => {
    const root = await newRoot()
    let engine = await open(root)
    await engine.createIndex(INDEX, ARTICLE_CONFIG)
    const random = seededRandom(30)
    const rareWord = (): string => `w${Math.floor(random() * 200_000).toString(36)}`
    const holders = new Map<string, string[]>()
    let total = 0
    for (let round = 0; round < 4; round++) {
      const batch = []
      for (let i = 0; i < 5_000; i++) {
        const id = `large-${round}-${i}`
        const words = Array.from({ length: 12 }, rareWord)
        if (i % 500 === 0) holders.set(words[0], [...(holders.get(words[0]) ?? []), id])
        batch.push({ id, title: words[0], body: words.join(' '), year: 2000, kept: rareWord().repeat(4_000) })
      }
      await engine.insertBatch(INDEX, batch)
      await engine.checkpoint(INDEX)
      total += batch.length
    }
    async function expectSampleAnswers(current: Narsil): Promise<void> {
      expect(await current.countDocuments(INDEX)).toBe(total)
      for (const [word, ids] of [...holders].slice(0, 30)) {
        const result = await current.query(INDEX, { term: word, fields: ['title'], limit: 100 })
        expect(result.hits.map(hit => hit.id).sort()).toEqual(expect.arrayContaining([...ids].sort()))
      }
    }
    await expectSampleAnswers(engine)
    let spilled = false
    const watching = setInterval(() => {
      void filesUnder(root)
        .then(files => {
          if (files.some(file => file.includes('/rebuilt/'))) spilled = true
        })
        .catch(() => undefined)
    }, 50)
    try {
      await engine.rebalance(INDEX, 2)
    } finally {
      clearInterval(watching)
    }
    expect(spilled).toBe(true)
    await expectSampleAnswers(engine)
    await engine.rebuildAnalysis(INDEX)
    await expectSampleAnswers(engine)
    expect((await filesUnder(root)).filter(file => file.includes('/rebuilt/'))).toEqual([])
    await engine.shutdown()
    engine = await open(root)
    await expectSampleAnswers(engine)
  }, 400_000)

  it('copies one partition to a replica that reads it from disk, through a checkpoint and a restart', async () => {
    const senderRoot = await newRoot()
    const sender = await createClusterLocalEngine({
      durability: { directory: senderRoot },
      workers: { enabled: false },
    })
    engines.push(sender)
    const oracle = await seeded(sender, 23)
    await sender.checkpoint(INDEX)
    const archived = await bytesOf((await sender.archiveReplicationPartition(INDEX, 0, () => 0)).stream)

    const replicaRoot = await newRoot()
    let replica = await createClusterLocalEngine({
      durability: { directory: replicaRoot },
      workers: { enabled: false },
    })
    engines.push(replica)
    await replica.restoreReplicationPartition(INDEX, 0, archived, ARTICLE_CONFIG, 1)
    await expectEngineMatchesOracle(replica, INDEX, oracle)
    await replica.checkpoint(INDEX)
    const again = await bytesOf((await sender.archiveReplicationPartition(INDEX, 0, () => 0)).stream)
    await replica.restoreReplicationPartition(INDEX, 0, again, ARTICLE_CONFIG, 1)
    await expectEngineMatchesOracle(replica, INDEX, oracle)
    expect((await filesUnder(replicaRoot)).filter(file => file.includes('/received/'))).toEqual([])
    await replica.shutdown()
    replica = await createClusterLocalEngine({ durability: { directory: replicaRoot }, workers: { enabled: false } })
    engines.push(replica)
    await expectEngineMatchesOracle(replica, INDEX, oracle)
  }, 180_000)
})

describe('worker copies of an index with its text on disk', () => {
  it('answer like the oracle, each worker opening the segment files for itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'narsil-disk-workers-'))
    const engine = await createNarsil({
      durability: { directory: root },
      workers: { enabled: true, count: 2, promotionThreshold: 100 },
    })
    try {
      await engine.createIndex(INDEX, ARTICLE_CONFIG)
      const random = seededRandom(24)
      const oracle = new ArticleOracle()
      for (let round = 0; round < 3; round++) {
        await writeRound(engine, oracle, random, `round-${round}`, 700)
        await engine.checkpoint(INDEX)
        await expectEngineMatchesOracle(engine, INDEX, oracle)
      }
      await writeRound(engine, oracle, random, 'live', 50)
      await expectEngineMatchesOracle(engine, INDEX, oracle)
    } finally {
      await engine.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)
})
