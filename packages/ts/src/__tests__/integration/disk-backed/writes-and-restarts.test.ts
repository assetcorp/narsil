import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { readMetadataEnvelope, writeMetadataEnvelope } from '../../../serialization/envelope'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig } from '../../../types/schema'
import { ArticleOracle, expectEngineMatchesOracle, randomArticle, seededRandom } from './oracle'

const INDEX = 'articles'

const ARTICLE_CONFIG: IndexConfig = {
  schema: { title: 'string', body: 'string', year: 'number' },
  language: 'english',
  textStorage: 'disk',
  surfaceForms: true,
}

describe('an index with its text on disk', () => {
  let root: string
  let engine: Narsil

  async function open(): Promise<Narsil> {
    engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    return engine
  }

  async function restart(): Promise<void> {
    await engine.shutdown()
    await open()
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-disk-writes-'))
    await open()
  })

  afterEach(async () => {
    await engine.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('answers like the oracle through checkpoints, writes between them, and restarts', async () => {
    await engine.createIndex(INDEX, ARTICLE_CONFIG)
    const random = seededRandom(95)
    const oracle = new ArticleOracle()
    let nextId = 0

    async function writeSome(count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        const known = [...oracle.documents.keys()]
        const roll = random()
        if (roll < 0.6 || known.length === 0) {
          const id = `article-${nextId++}`
          const document = randomArticle(random)
          await engine.insert(INDEX, document, id)
          oracle.set(id, document)
        } else if (roll < 0.8) {
          const id = known[Math.floor(random() * known.length)]
          const document = randomArticle(random)
          await engine.update(INDEX, id, document)
          oracle.set(id, document)
        } else {
          const id = known[Math.floor(random() * known.length)]
          await engine.remove(INDEX, id)
          oracle.delete(id)
        }
      }
    }

    for (let round = 0; round < 4; round++) {
      await writeSome(300)
      await expectEngineMatchesOracle(engine, INDEX, oracle)
      await engine.checkpoint(INDEX)
      await expectEngineMatchesOracle(engine, INDEX, oracle)
      await writeSome(40)
      await expectEngineMatchesOracle(engine, INDEX, oracle)
      await restart()
      await expectEngineMatchesOracle(engine, INDEX, oracle)
    }
  }, 120_000)

  it('keeps writes that arrive while a checkpoint is on its way to disk', async () => {
    await engine.createIndex(INDEX, ARTICLE_CONFIG)
    const random = seededRandom(7)
    const oracle = new ArticleOracle()
    for (let i = 0; i < 500; i++) {
      const document = randomArticle(random)
      await engine.insert(INDEX, document, `settled-${i}`)
      oracle.set(`settled-${i}`, document)
    }
    const writes: Array<Promise<unknown>> = [engine.checkpoint(INDEX)]
    for (let i = 0; i < 200; i++) {
      const replacement = randomArticle(random)
      writes.push(engine.update(INDEX, `settled-${i}`, replacement))
      oracle.set(`settled-${i}`, replacement)
      const added = randomArticle(random)
      writes.push(engine.insert(INDEX, added, `arrived-${i}`))
      oracle.set(`arrived-${i}`, added)
    }
    for (let i = 200; i < 300; i++) {
      writes.push(engine.remove(INDEX, `settled-${i}`))
      oracle.delete(`settled-${i}`)
    }
    await Promise.all(writes)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await engine.checkpoint(INDEX)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await restart()
    await expectEngineMatchesOracle(engine, INDEX, oracle)
  })

  it('keeps a document deleted and written again before one checkpoint', async () => {
    await engine.createIndex(INDEX, ARTICLE_CONFIG)
    const oracle = new ArticleOracle()
    const first = { title: 'amber basil', body: 'cedar', year: 2001 }
    const second = { title: 'dahlia ember', body: 'fennel', year: 2011 }
    await engine.insert(INDEX, first, 'reborn')
    await engine.insert(INDEX, { title: 'garnet', body: 'hazel', year: 1999 }, 'neighbour')
    oracle.set('neighbour', { title: 'garnet', body: 'hazel', year: 1999 })
    await engine.checkpoint(INDEX)
    await engine.remove(INDEX, 'reborn')
    await engine.insert(INDEX, second, 'reborn')
    oracle.set('reborn', second)
    await engine.checkpoint(INDEX)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await restart()
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await engine.checkpoint(INDEX)
    await restart()
    await expectEngineMatchesOracle(engine, INDEX, oracle)
  })

  it('answers with only the new copy when an older paged segment holds the old copy', async () => {
    await engine.createIndex(INDEX, ARTICLE_CONFIG)
    const oracle = new ArticleOracle()
    await engine.insert(INDEX, { title: 'amber', body: 'basil', year: 2000 }, 'moved')
    await engine.checkpoint(INDEX)
    const replacement = { title: 'indigo', body: 'jasmin', year: 2015 }
    await engine.update(INDEX, 'moved', replacement)
    oracle.set('moved', replacement)
    await engine.checkpoint(INDEX)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await restart()
    await expectEngineMatchesOracle(engine, INDEX, oracle)
  })

  it('answers with only the new copy when an older segment of the earlier format holds the old copy', async () => {
    await engine.createIndex(INDEX, { ...ARTICLE_CONFIG, textStorage: 'memory' })
    const oracle = new ArticleOracle()
    const stays = { title: 'kestrel', body: 'lantern', year: 1995 }
    await engine.insert(INDEX, { title: 'amber', body: 'basil', year: 2000 }, 'moved')
    await engine.insert(INDEX, { title: 'cedar', body: 'dahlia', year: 2002 }, 'deleted')
    await engine.insert(INDEX, stays, 'stays')
    oracle.set('stays', stays)
    await engine.checkpoint(INDEX)
    await engine.shutdown()

    const metaPath = join(root, INDEX, 'meta')
    const { metadata } = await readMetadataEnvelope(new Uint8Array(await readFile(metaPath)))
    await writeFile(metaPath, await writeMetadataEnvelope({ ...metadata, textStorage: 'disk' }, { checksum: true }))
    await open()
    await expectEngineMatchesOracle(
      engine,
      INDEX,
      Object.assign(new ArticleOracle(), {
        documents: new Map([
          ['moved', { title: 'amber', body: 'basil', year: 2000 }],
          ['deleted', { title: 'cedar', body: 'dahlia', year: 2002 }],
          ['stays', stays],
        ]),
      }),
    )

    const replacement = { title: 'indigo', body: 'jasmin', year: 2015 }
    await engine.update(INDEX, 'moved', replacement)
    oracle.set('moved', replacement)
    await engine.remove(INDEX, 'deleted')
    await engine.checkpoint(INDEX)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    await restart()
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    expect(await engine.has(INDEX, 'deleted')).toBe(false)
  })
})
